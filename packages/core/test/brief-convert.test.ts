import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { domainEvents } from '../src/db/schema';
import { briefContextMarkdown } from '../src/documents/brief-model';
import { convertBriefToPrd, createBrief, getBriefContext, updateBrief } from '../src/documents/briefs';
import { createDocument, getDocumentByKey, listDocuments, listRevisions, saveDocumentContent, transitionDocument } from '../src/documents/documents';
import type { Actor } from '../src/domain-types';
import { listBacklinks } from '../src/links/backlinks';
import { createRequirement } from '../src/requirements/requirements';
import { updateMember } from '../src/tenancy/members';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, readOnlyToken, seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let editor: Actor;
let viewer: Actor;
let guest: Actor;
let pan: string;

const eventOf = async (subjectId: string, type: string) =>
  (await t.adminDb.select().from(domainEvents).where(and(eq(domainEvents.subjectId, subjectId), eq(domainEvents.type, type))))[0];

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  editor = await asMember(t.db, owner, '编辑甲');
  viewer = await asMember(t.db, owner, '只读乙');
  await setProductRole(t.db, owner, pan, viewer.memberId, 'viewer');
  guest = await asMember(t.db, owner, '访客丙', 'guest');
});
afterAll(() => t.cleanup());

describe('转 PRD', () => {
  it('生成草稿：按对应表拼接；覆盖没挂 PRD 的需求，已挂别的 PRD 的跳过并列出；简报改为已转 PRD；两边互相可见；记事件', async () => {
    const r1 = await createRequirement(t.db, editor, pan, { title: '需求一' });
    const r2 = await createRequirement(t.db, editor, pan, { title: '需求二' });
    const r3 = await createRequirement(t.db, editor, pan, { title: '需求三' });
    await createDocument(t.db, editor, pan, { title: '旧 PRD', requirementIds: [r2.id] });
    const b = await createBrief(t.db, editor, pan, { title: '上传提速', requirementIds: [r1.id, r2.id, r3.id] });
    await saveDocumentContent(t.db, editor, b.id, { baseVersion: b.version, markdown: '## 1. 问题与目标\n\n上传失败率 3%。\n' });

    const res = await convertBriefToPrd(t.db, editor, b.id);
    expect(res.document).toMatchObject({
      displayKey: 'PAN-PRD-2',
      kind: 'change',
      status: 'draft',
      source: 'native',
      templateId: null,
      title: '上传提速',
      owner: { id: editor.memberId },
      sourceBrief: { id: b.id, displayKey: 'PAN-B-1', title: '上传提速' },
      templateGuidance: null,
    });
    expect(res.document.requirements.map((r) => r.displayKey)).toEqual(['PAN-1', 'PAN-3']);
    expect(res.document.markdown!.split('\n')[0]).toBe('> 由简报 [[PAN-B-1]] 生成。各章节下的引用块注明内容来自简报的哪一节，请按 PRD 的写法改写后再提交评审。');
    expect(res.document.markdown).toContain('> 来自简报第 1 节「问题与目标」\n\n上传失败率 3%。');
    expect(res.skipped).toEqual([{ id: r2.id, displayKey: 'PAN-2', title: '需求二', documentKey: 'PAN-PRD-1' }]);

    const brief = await getDocumentByKey(t.db, editor, 'PAN-B-1');
    expect([brief.status, brief.transitions]).toEqual(['converted', ['discussing', 'discarded']]);
    expect(brief.brief!.convertedDocument).toMatchObject({ id: res.document.id, displayKey: 'PAN-PRD-2', status: 'draft' });
    expect((await listRevisions(t.db, editor, res.document.id)).map((r) => r.summary)).toEqual(['由简报 PAN-B-1 生成']);
    expect((await listBacklinks(t.db, editor, { type: 'document', id: b.id })).map((g) => g.displayKey)).toEqual(['PAN-PRD-2']);
    expect((await eventOf(b.id, 'document.status_changed'))!.payload).toMatchObject({ kind: 'brief', changes: [{ field: 'status', old: 'discussing', new: 'converted' }] });
    expect((await eventOf(b.id, 'brief.converted'))!.payload).toMatchObject({ documentId: res.document.id, documentKey: 'PAN-PRD-2', skipped: ['PAN-2'] });
    expect((await eventOf(res.document.id, 'document.created'))!.payload).toMatchObject({ fromBriefId: b.id });
  });

  it('再转：原 PRD 还在时返回 409 并给出编号；确认后生成新草稿，原 PRD 与它覆盖的需求保留', async () => {
    const b = await getDocumentByKey(t.db, editor, 'PAN-B-1');
    await expect(convertBriefToPrd(t.db, editor, b.id)).rejects.toMatchObject({ code: 'conflict', message: '这份简报已转为 PAN-PRD-2', details: { documentKey: 'PAN-PRD-2' } });
    const res = await convertBriefToPrd(t.db, editor, b.id, { again: true });
    expect(res.document.displayKey).toBe('PAN-PRD-3');
    expect(res.document.requirements).toEqual([]);
    expect(res.skipped.map((s) => [s.displayKey, s.documentKey])).toEqual([
      ['PAN-1', 'PAN-PRD-2'],
      ['PAN-2', 'PAN-PRD-1'],
      ['PAN-3', 'PAN-PRD-2'],
    ]);
    const prev = await getDocumentByKey(t.db, editor, 'PAN-PRD-2');
    expect([prev.requirements.map((r) => r.displayKey), prev.sourceBrief]).toEqual([['PAN-1', 'PAN-3'], null]);
    expect((await getDocumentByKey(t.db, editor, 'PAN-B-1')).brief!.convertedDocument!.displayKey).toBe('PAN-PRD-3');
    expect((await getDocumentByKey(t.db, editor, 'PAN-PRD-3')).sourceBrief!.displayKey).toBe('PAN-B-1');
  });

  it('只读不能转；看不到时按不存在处理；已废弃的不能转；作者已离开时新 PRD 不设负责人', async () => {
    const b2 = await createBrief(t.db, editor, pan, { title: '要废弃的简报' });
    await expect(convertBriefToPrd(t.db, viewer, b2.id)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(convertBriefToPrd(t.db, readOnlyToken(owner), b2.id)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(convertBriefToPrd(t.db, guest, b2.id)).rejects.toMatchObject({ code: 'not_found', message: '简报不存在' });
    await transitionDocument(t.db, editor, b2.id, { to: 'discarded' });
    await expect(convertBriefToPrd(t.db, editor, b2.id)).rejects.toThrow('已废弃的简报不能转 PRD');
    const leaver = await asMember(t.db, owner, '离开的作者');
    const b3 = await createBrief(t.db, leaver, pan, { title: '作者会离开' });
    await updateMember(t.db, owner, leaver.memberId, { status: 'left' });
    expect((await convertBriefToPrd(t.db, editor, b3.id)).document.owner).toBeNull();
  });

  it('拼出的 PRD 超过 30 万字时报错，不新建文档', async () => {
    const b4 = await createBrief(t.db, editor, pan, { title: '很长的简报' });
    await saveDocumentContent(t.db, editor, b4.id, { baseVersion: b4.version, markdown: `## 1. 问题与目标\n\n${'很'.repeat(110_000)}\n` });
    const before = (await listDocuments(t.db, editor, pan)).length;
    await expect(convertBriefToPrd(t.db, editor, b4.id)).rejects.toThrow('生成的 PRD 超过 300000 个字符，请先精简简报正文');
    expect(await listDocuments(t.db, editor, pan)).toHaveLength(before);
  });
});

describe('上下文', () => {
  it('头部、覆盖的需求与状态名、闸口、转出的 PRD 与正文；只读 Token 可读；看不到时按不存在处理', async () => {
    const b = await getDocumentByKey(t.db, editor, 'PAN-B-1');
    await updateBrief(t.db, editor, b.id, { deciderMemberId: viewer.memberId, relatedLinks: [{ kind: 'wiki', target: 'PAN-PRD-1', note: '旧方案' }] });
    const ctx = await getBriefContext(t.db, readOnlyToken(owner), b.id);
    expect(ctx.brief).toMatchObject({
      displayKey: 'PAN-B-1',
      title: '上传提速',
      status: 'converted',
      statusLabel: '已转 PRD',
      product: { key: 'PAN', name: '网盘' },
      version: 'v0.1',
      decider: '只读乙',
      author: '编辑甲',
      requester: null,
      relatedLinks: [{ kind: 'wiki', target: 'PAN-PRD-1', note: '旧方案' }],
      convertedDocument: { displayKey: 'PAN-PRD-3', title: '上传提速', statusLabel: '草稿' },
    });
    expect(ctx.requirements).toEqual([
      { displayKey: 'PAN-1', title: '需求一', state: '待处理' },
      { displayKey: 'PAN-2', title: '需求二', state: '待处理' },
      { displayKey: 'PAN-3', title: '需求三', state: '待处理' },
    ]);
    expect(ctx.gate.total).toBe(11);
    expect(ctx.markdown).toContain('上传失败率 3%。');
    const md = briefContextMarkdown(ctx);
    expect(md.startsWith('# PAN-B-1 上传提速\n')).toBe(true);
    expect(md).toContain('| 转出的 PRD | PAN-PRD-3 上传提速（草稿） |');
    expect(md).toContain('## 正文\n\n### 1. 问题与目标');
    await expect(getBriefContext(t.db, guest, b.id)).rejects.toMatchObject({ code: 'not_found', message: '简报不存在' });
  });
});
