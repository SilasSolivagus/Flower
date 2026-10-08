import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { documentRevisions, domainEvents } from '../src/db/schema';
import type { Actor } from '../src/domain-types';
import {
  convertExternalDocument,
  createDocument,
  diffRevisions,
  getDocumentByKey,
  getRevision,
  listDocuments,
  listRevisions,
  restoreRevision,
  saveDocumentContent,
  transitionDocument,
  updateDocument,
} from '../src/documents/documents';
import { listTemplates } from '../src/documents/templates';
import { createPlaceholderMember, updateMember } from '../src/tenancy/members';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, readOnlyToken, seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let editor: Actor;
let viewer: Actor;
let pan: string;
let preset: string;

const WECOM = 'https://doc.weixin.qq.com/doc/w3_ABC?scode=one';

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  editor = await asMember(t.db, owner, '编辑甲');
  viewer = await asMember(t.db, owner, '只读乙');
  await setProductRole(t.db, owner, pan, viewer.memberId, 'viewer');
  preset = (await listTemplates(t.db, owner, {}))[0]!.id;
});
afterAll(() => t.cleanup());

/** 把某份文档最近一条修订的保存时间往前拨，模拟「距上次保存已超过 5 分钟」。 */
async function ageLatestRevision(documentId: string, minutes: number) {
  const rows = await t.adminDb.select().from(documentRevisions).where(eq(documentRevisions.documentId, documentId));
  const last = rows.sort((a, b) => b.version - a.version)[0]!;
  await t.adminDb.update(documentRevisions).set({ updatedAt: new Date(Date.now() - minutes * 60_000) }).where(eq(documentRevisions.id, last.id));
}

describe('新建与列表', () => {
  it('Flower 文档按模板生成正文与第 1 版，编号按产品自增', async () => {
    const d = await createDocument(t.db, editor, pan, { title: '上传提速 PRD', templateId: preset, ownerMemberId: editor.memberId });
    expect(d).toMatchObject({ displayKey: 'PAN-PRD-1', source: 'native', status: 'draft', revisionNumber: 1, version: 1, owner: { id: editor.memberId }, transitions: ['review', 'discarded'] });
    expect(d.markdown).toContain('## 1. 背景介绍');
    expect(d.markdown).toContain('| 编辑甲 | 初稿 |');
    expect(d.markdown).not.toContain('{{date}}');
  });

  it('外部 PRD 只存网址：识别平台；同一规范化网址在同一产品内只能有一份；不是网址报错', async () => {
    const d = await createDocument(t.db, editor, pan, { title: '外部方案', externalUrl: WECOM });
    expect(d).toMatchObject({ displayKey: 'PAN-PRD-2', source: 'external', externalUrl: WECOM, externalProvider: 'wecom', markdown: null, revisionNumber: null });
    await expect(createDocument(t.db, editor, pan, { title: '重复', externalUrl: 'https://doc.weixin.qq.com/doc/w3_ABC/?scode=two#x' })).rejects.toMatchObject({
      code: 'conflict',
      message: '该网址已对应 PAN-PRD-2',
    });
    await expect(createDocument(t.db, editor, pan, { title: '坏链接', externalUrl: '见附件' })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('权限：只读成员与只读 Token 不能新建；负责人必须是在职的人类成员', async () => {
    await expect(createDocument(t.db, viewer, pan, { title: 'x' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(createDocument(t.db, readOnlyToken(owner), pan, { title: 'x' })).rejects.toMatchObject({ code: 'forbidden' });
    const left = await createPlaceholderMember(t.db, owner, { displayName: '离职丙' });
    await updateMember(t.db, owner, left.id, { status: 'left' });
    await expect(createDocument(t.db, editor, pan, { title: 'x', ownerMemberId: left.id })).rejects.toMatchObject({ message: '该成员已离开组织，不能选择' });
  });

  it('列表按状态、负责人、来源、关键词筛选；按编号取详情', async () => {
    expect((await listDocuments(t.db, viewer, pan)).map((d) => d.displayKey)).toEqual(['PAN-PRD-2', 'PAN-PRD-1']);
    expect((await listDocuments(t.db, viewer, pan, { source: 'external' })).map((d) => d.displayKey)).toEqual(['PAN-PRD-2']);
    expect((await listDocuments(t.db, viewer, pan, { ownerIds: [editor.memberId] })).map((d) => d.displayKey)).toEqual(['PAN-PRD-1']);
    expect((await listDocuments(t.db, viewer, pan, { q: 'PAN-PRD-2' })).map((d) => d.title)).toEqual(['外部方案']);
    expect((await listDocuments(t.db, viewer, pan, { statuses: ['review'] }))).toEqual([]);
    const d = await getDocumentByKey(t.db, viewer, 'PAN-PRD-1');
    expect(d).toMatchObject({ title: '上传提速 PRD', myRole: 'viewer', transitions: [] });
    await expect(getDocumentByKey(t.db, viewer, 'PAN-PRD-99')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('保存、修订与恢复', () => {
  it('同一作者 5 分钟内的保存合并为一版；换人或超过 5 分钟另起一版；版本号不对返回 409', async () => {
    const d = await createDocument(t.db, editor, pan, { title: '修订测试' });
    const r1 = await saveDocumentContent(t.db, editor, d.id, { baseVersion: 1, markdown: '## 背景\n\n第一稿' });
    expect(r1).toEqual({ version: 2, revisionNumber: 1, merged: true });
    const r2 = await saveDocumentContent(t.db, owner, d.id, { baseVersion: 2, markdown: '## 背景\n\n第二稿' });
    expect(r2).toEqual({ version: 3, revisionNumber: 2, merged: false });
    await ageLatestRevision(d.id, 6);
    const r3 = await saveDocumentContent(t.db, owner, d.id, { baseVersion: 3, markdown: '## 背景\n\n第三稿\n\n## 需求\n\n- 分片' });
    expect(r3).toEqual({ version: 4, revisionNumber: 3, merged: false });
    await expect(saveDocumentContent(t.db, editor, d.id, { baseVersion: 3, markdown: 'x' })).rejects.toMatchObject({ code: 'conflict', details: { version: 4 } });
    expect((await listRevisions(t.db, viewer, d.id)).map((r) => [r.number, r.author?.displayName, r.summary])).toEqual([
      [3, 'Owner', null],
      [2, 'Owner', null],
      [1, '编辑甲', null],
    ]);
    const diff = await diffRevisions(t.db, viewer, d.id, { from: 1, to: 3 });
    expect(diff.sections.map((s) => [s.key, s.change])).toEqual([
      ['背景', 'modified'],
      ['需求', 'added'],
    ]);
  });

  it('恢复：以旧快照新建一版，摘要「恢复到第 N 版」，记 document.restored 事件', async () => {
    const d = await createDocument(t.db, editor, pan, { title: '恢复测试' });
    await saveDocumentContent(t.db, editor, d.id, { baseVersion: 1, markdown: '旧正文', title: '旧标题' });
    await ageLatestRevision(d.id, 6);
    await saveDocumentContent(t.db, editor, d.id, { baseVersion: 2, markdown: '新正文', title: '新标题' });
    const r = await restoreRevision(t.db, editor, d.id, { number: 1, baseVersion: 3 });
    expect(r).toEqual({ version: 4, revisionNumber: 3, merged: false });
    expect(await getRevision(t.db, viewer, d.id, 3)).toMatchObject({ title: '旧标题', markdown: '旧正文' });
    const after = await getDocumentByKey(t.db, viewer, d.displayKey);
    expect(after).toMatchObject({ title: '旧标题', markdown: '旧正文', revisionNumber: 3 });
    expect((await listRevisions(t.db, viewer, d.id))[0]!.summary).toBe('恢复到第 1 版');
    const events = await t.adminDb.select().from(domainEvents).where(eq(domainEvents.subjectId, d.id));
    expect(events.map((e) => e.type)).toContain('document.restored');
    // 恢复之后同一作者马上保存，不能合并进「恢复」那一版
    expect(await saveDocumentContent(t.db, editor, d.id, { baseVersion: 4, markdown: '恢复后再改' })).toMatchObject({ revisionNumber: 4, merged: false });
  });

  it('正文不能内嵌 data: 图片；外部 PRD 不能保存正文；只读成员不能保存', async () => {
    const d = await createDocument(t.db, editor, pan, { title: '校验' });
    await expect(saveDocumentContent(t.db, editor, d.id, { baseVersion: 1, markdown: '![](data:image/png;base64,AAAA)' })).rejects.toMatchObject({
      message: '正文中不能内嵌图片数据，请上传图片',
    });
    await expect(saveDocumentContent(t.db, viewer, d.id, { baseVersion: 1, markdown: 'x' })).rejects.toMatchObject({ code: 'forbidden' });
    const ext = await createDocument(t.db, editor, pan, { title: '外部', externalUrl: 'https://docs.qq.com/doc/zz' });
    await expect(saveDocumentContent(t.db, editor, ext.id, { baseVersion: 1, markdown: 'x' })).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('状态流转与转换', () => {
  it('按流转表限制目标；提交评审时检查模板必填小节', async () => {
    const d = await createDocument(t.db, editor, pan, { title: '必填测试', templateId: preset });
    await expect(transitionDocument(t.db, editor, d.id, { to: 'approved' })).rejects.toMatchObject({ code: 'invalid', message: '不能从「草稿」改为「已通过」' });
    await expect(transitionDocument(t.db, editor, d.id, { to: 'review' })).rejects.toMatchObject({
      code: 'invalid',
      message: '以下必填小节未填写：1. 背景介绍、3. 需求说明',
      details: { missing: ['1. 背景介绍', '3. 需求说明'] },
    });
    const filled = d.markdown!.replace('简述本需求所处的业务背景、当前问题。', '上传慢的投诉占三成。').replace('| R1 | 待填 | P0 | 待评审 |', '| R1 | 分片上传 | P0 | 待评审 |');
    await saveDocumentContent(t.db, editor, d.id, { baseVersion: 1, markdown: filled });
    expect(await transitionDocument(t.db, editor, d.id, { to: 'review' })).toMatchObject({ status: 'review', transitions: ['draft', 'approved', 'discarded'] });
    await expect(transitionDocument(t.db, viewer, d.id, { to: 'approved' })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('外部 PRD 修改链接；转为 Flower 文档后保留原链接、生成第 1 版，不再是外部', async () => {
    const d = await createDocument(t.db, editor, pan, { title: '待转换', externalUrl: 'https://abc.feishu.cn/docx/1' });
    const moved = await updateDocument(t.db, editor, d.id, { externalUrl: 'https://abc.feishu.cn/docx/2' });
    expect(moved).toMatchObject({ externalUrl: 'https://abc.feishu.cn/docx/2', externalProvider: 'feishu', version: 1 });
    const r = await convertExternalDocument(t.db, editor, d.id, { baseVersion: 1, markdown: '## 背景\n\n从飞书粘贴' });
    expect(r).toEqual({ version: 2, revisionNumber: 1, merged: false });
    const after = await getDocumentByKey(t.db, viewer, d.displayKey);
    expect(after).toMatchObject({ source: 'native', externalUrl: 'https://abc.feishu.cn/docx/2', markdown: '## 背景\n\n从飞书粘贴', revisionNumber: 1 });
    await expect(convertExternalDocument(t.db, editor, d.id, { baseVersion: 2, markdown: 'x' })).rejects.toMatchObject({ message: '只有外部 PRD 可以转为 Flower 文档' });
    await expect(createDocument(t.db, editor, pan, { title: '同链接', externalUrl: 'https://abc.feishu.cn/docx/2' })).rejects.toMatchObject({ code: 'conflict' });
  });
});
