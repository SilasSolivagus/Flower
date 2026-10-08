import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { domainEvents } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import type { Actor } from '../src/domain-types';
import { addDocumentComment, listDocumentComments, setDocumentCommentResolved } from '../src/documents/comments';
import { createDocument, restoreRevision, saveDocumentContent } from '../src/documents/documents';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, readOnlyToken, seedInstance } from './factories';

const V1 = '## 1. 背景\n\n上传大文件时经常超时，用户需要重新上传。\n\n## 2. 方案\n\n采用分片上传。';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let editor: Actor;
let viewer: Actor;
let pan: string;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  editor = await asMember(t.db, owner, '编辑甲');
  viewer = await asMember(t.db, owner, '只读乙');
  await setProductRole(t.db, owner, pan, viewer.memberId, 'viewer');
});
afterAll(() => t.cleanup());

describe('文档评论', () => {
  it('只读成员可以划词评论与整篇评论；只读 Token 不能评论', async () => {
    const d = await createDocument(t.db, editor, pan, { title: '评论测试' });
    await saveDocumentContent(t.db, editor, d.id, { baseVersion: 1, markdown: V1 });
    const c = await addDocumentComment(t.db, viewer, d.id, { body: '超时时间是多少？', anchor: { quote: '经常超时', prefix: '上传大文件时', suffix: '，用户需要' } });
    expect(c).toMatchObject({ anchorState: 'ok', anchor: { quote: '经常超时', sectionHeading: '1. 背景' }, author: { displayName: '只读乙' } });
    const whole = await addDocumentComment(t.db, viewer, d.id, { body: '整体同意' });
    expect(whole).toMatchObject({ anchor: null, anchorState: null });
    await expect(addDocumentComment(t.db, readOnlyToken(owner), d.id, { body: 'x' })).rejects.toMatchObject({ code: 'forbidden', message: '只读 Token 不能评论' });
    await expect(addDocumentComment(t.db, viewer, d.id, { body: 'x', anchor: { quote: '正文里没有的话' } })).rejects.toMatchObject({
      code: 'invalid',
      message: '所选文字在当前版本中找不到，请刷新后重新选择',
    });
    const reply = await addDocumentComment(t.db, editor, d.id, { body: '30 秒', parentId: c.id });
    expect(reply.parentId).toBe(c.id);
    await expect(addDocumentComment(t.db, editor, d.id, { body: 'x', parentId: c.id, anchor: { quote: '分片上传' } })).rejects.toMatchObject({ message: '回复不能再选择原文' });
    expect((await listDocumentComments(t.db, viewer, d.id)).map((x) => x.body)).toEqual(['超时时间是多少？', '整体同意', '30 秒']);
  });

  it('原文改动后评论标为已失效；恢复后重新定位为正常；小节改名时更新小节', async () => {
    const d = await createDocument(t.db, editor, pan, { title: '失效测试' });
    await saveDocumentContent(t.db, editor, d.id, { baseVersion: 1, markdown: V1 });
    const c = await addDocumentComment(t.db, viewer, d.id, { body: '为什么用分片？', anchor: { quote: '分片上传', prefix: '采用', suffix: '' } });
    await saveDocumentContent(t.db, owner, d.id, { baseVersion: 2, markdown: V1.replace('## 2. 方案', '## 2. 技术方案') });
    expect((await listDocumentComments(t.db, viewer, d.id))[0]).toMatchObject({ anchorState: 'ok', anchor: { sectionHeading: '2. 技术方案' } });
    await saveDocumentContent(t.db, owner, d.id, { baseVersion: 3, markdown: V1.replace('采用分片上传。', '改用断点续传。') });
    expect((await listDocumentComments(t.db, viewer, d.id))[0]).toMatchObject({ id: c.id, anchorState: 'stale' });
    await restoreRevision(t.db, editor, d.id, { number: 1, baseVersion: 4 });
    expect((await listDocumentComments(t.db, viewer, d.id))[0]).toMatchObject({ anchorState: 'ok', anchor: { sectionHeading: '2. 方案' } });
  });

  it('外部 PRD 只能整篇评论；作者或产品编辑可以标为已解决，其他只读成员不行', async () => {
    const d = await createDocument(t.db, editor, pan, { title: '外部', externalUrl: 'https://docs.qq.com/doc/c1' });
    await expect(addDocumentComment(t.db, viewer, d.id, { body: 'x', anchor: { quote: 'y' } })).rejects.toMatchObject({ message: '外部 PRD 不能划词评论' });
    const c = await addDocumentComment(t.db, editor, d.id, { body: '链接打不开' });
    await expect(setDocumentCommentResolved(t.db, viewer, c.id, { resolved: true })).rejects.toMatchObject({ code: 'forbidden' });
    expect(await setDocumentCommentResolved(t.db, editor, c.id, { resolved: true })).toMatchObject({ resolvedBy: { displayName: '编辑甲' } });
    expect(await setDocumentCommentResolved(t.db, owner, c.id, { resolved: false })).toMatchObject({ resolvedAt: null, resolvedBy: null });
    const events = await withOrg(t.db, owner.orgId, (tx) =>
      tx.select().from(domainEvents).where(and(eq(domainEvents.subjectId, d.id), eq(domainEvents.subjectType, 'document'))),
    );
    expect(events.find((e) => e.type === 'comment.resolved')).toMatchObject({ payload: { changes: [{ field: 'resolved', old: false, new: true }] } });
    expect(events.find((e) => e.type === 'comment.reopened')).toMatchObject({ payload: { changes: [{ field: 'resolved', old: true, new: false }] } });
    const mine = await addDocumentComment(t.db, viewer, d.id, { body: '我自己的' });
    expect((await setDocumentCommentResolved(t.db, viewer, mine.id, { resolved: true })).resolvedAt).not.toBeNull();
  });
});
