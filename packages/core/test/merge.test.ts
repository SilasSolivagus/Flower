import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkItemResults, documentAffectedNodes, documentRevisions, domainEvents } from '../src/db/schema';
import { createWorkflowTemplate, setProductWorkflowVersion } from '../src/definitions/workflows';
import { addAffectedNode } from '../src/documents/affected';
import { createDocument, type DocumentDetail, getDocument, saveDocumentContent, transitionDocument } from '../src/documents/documents';
import { applyMerge, getMergePlan, reopenMerge, skipMerge } from '../src/documents/merge';
import { createModuleDocument } from '../src/documents/module-docs';
import type { Actor } from '../src/domain-types';
import type { StructureNodeView } from '../src/requirements/lookups';
import { createRequirement, type RequirementListItem } from '../src/requirements/requirements';
import { createStructureNode } from '../src/structure/nodes';
import { listFunctionTags } from '../src/tenancy/function-tags';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, prdWorkflow, readOnlyToken, seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let editor: Actor;
let viewer: Actor;
let pan: string;
let upload: StructureNodeView;
let download: StructureNodeView;
let chunk: StructureNodeView;
let instant: StructureNodeView;
let legacy: StructureNodeView;
let offline: StructureNodeView;
let moduleDoc: DocumentDetail;
let prd: DocumentDetail;
let req: RequirementListItem;

const PRD_BODY = '## 背景\n\n现状\n\n## 需求说明\n\n上传改为分片\n\n### 细节\n\n断点续传';
const MODULE_BODY = '上传总述\n\n## 秒传\n\n秒传说明\n\n## 旧接口\n\n旧接口说明\n';

async function prdState(requirementId: string): Promise<string | undefined> {
  const [r] = await t.adminDb
    .select({ state: checkItemResults.state })
    .from(checkItemResults)
    .where(and(eq(checkItemResults.targetType, 'requirement'), eq(checkItemResults.targetId, requirementId), eq(checkItemResults.itemKey, 'prd')));
  return r?.state;
}

/** 声明行的合入列：applied 全部有值；skipped 只有处理人与时间；pending 全部为空。 */
async function mergeColumns(nodeId: string) {
  const [r] = await t.adminDb
    .select()
    .from(documentAffectedNodes)
    .where(and(eq(documentAffectedNodes.documentId, prd.id), eq(documentAffectedNodes.nodeId, nodeId)));
  return { status: r!.mergeStatus, revisionId: r!.mergedRevisionId, by: r!.mergedBy, at: r!.mergedAt !== null };
}

const markdownOf = async (id: string) => (await getDocument(t.db, owner, id)).markdown;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  const designTag = (await listFunctionTags(t.db, owner)).find((x) => x.name === '设计')!.id;
  const { version } = await createWorkflowTemplate(t.db, owner, { name: 'PRD 流程', body: prdWorkflow(designTag) });
  await setProductWorkflowVersion(t.db, owner, pan, version.id);
  editor = await asMember(t.db, owner, '编辑甲');
  viewer = await asMember(t.db, owner, '只读乙');
  await setProductRole(t.db, owner, pan, viewer.memberId, 'viewer');
  const storage = await createStructureNode(t.db, owner, pan, { name: '存储' });
  upload = await createStructureNode(t.db, owner, pan, { parentId: storage.id, name: '上传' });
  chunk = await createStructureNode(t.db, owner, pan, { parentId: upload.id, name: '分片上传' });
  instant = await createStructureNode(t.db, owner, pan, { parentId: upload.id, name: '秒传' });
  legacy = await createStructureNode(t.db, owner, pan, { parentId: upload.id, name: '旧接口' });
  download = await createStructureNode(t.db, owner, pan, { parentId: storage.id, name: '下载' });
  offline = await createStructureNode(t.db, owner, pan, { parentId: download.id, name: '离线下载' });
  req = await createRequirement(t.db, owner, pan, { title: '分片上传' });
  prd = await createDocument(t.db, owner, pan, { title: '上传改版', requirementIds: [req.id] }); // PAN-PRD-1
  await saveDocumentContent(t.db, owner, prd.id, { baseVersion: prd.version, markdown: PRD_BODY });
  moduleDoc = await createModuleDocument(t.db, owner, upload.id); // PAN-PRD-2
  await saveDocumentContent(t.db, owner, moduleDoc.id, { baseVersion: moduleDoc.version, markdown: MODULE_BODY });
  await addAffectedNode(t.db, owner, prd.id, { nodeId: chunk.id, changeType: 'added', sourceSections: ['需求说明'] });
  await addAffectedNode(t.db, owner, prd.id, { nodeId: instant.id, changeType: 'modified', sourceSections: ['需求说明 / 细节', '背景'] });
  await addAffectedNode(t.db, owner, prd.id, { nodeId: legacy.id, changeType: 'removed' });
  await addAffectedNode(t.db, owner, prd.id, { nodeId: offline.id, changeType: 'added' });
});
afterAll(() => t.cleanup());

describe('合入', () => {
  it('合入页：按模块分组，左侧为模块文档现状，右侧预填来源小节；未上线时不能合入', async () => {
    const plan = await getMergePlan(t.db, editor, prd.id);
    expect(plan).toMatchObject({ document: { displayKey: 'PAN-PRD-1', status: 'draft' }, canMerge: false, canReopen: false, done: 0, total: 4 });
    expect(plan.groups.map((g) => [g.module?.path, g.document?.displayKey ?? null])).toEqual([
      ['存储/上传', 'PAN-PRD-2'],
      ['存储/下载', null],
    ]);
    expect(plan.groups[0]!.items.map((i) => [i.name, i.current, i.prefill])).toEqual([
      ['分片上传', null, '上传改为分片\n\n### 细节\n\n断点续传'],
      ['秒传', '秒传说明', '断点续传\n\n现状'],
      ['旧接口', '旧接口说明', ''],
    ]);
    expect(plan.groups[1]!.items.map((i) => [i.name, i.current, i.prefill])).toEqual([['离线下载', null, '']]);
    await expect(applyMerge(t.db, owner, prd.id, chunk.id, { baseVersion: plan.groups[0]!.document!.version, body: 'x' })).rejects.toThrow('只有已上线的 PRD 可以合入');
    for (const to of ['review', 'approved', 'launched'] as const) await transitionDocument(t.db, owner, prd.id, { to });
    expect(await getMergePlan(t.db, viewer, prd.id)).toMatchObject({ canMerge: false, canReopen: false });
    expect(await getMergePlan(t.db, editor, prd.id)).toMatchObject({ canMerge: true, canReopen: true });
  });

  it('应用：新增按结构树顺序插入、修改替换、删除移除；每次一版，带合入来源；版本冲突；内容不能有二级标题', async () => {
    let plan = await getMergePlan(t.db, editor, prd.id);
    const v0 = plan.groups[0]!.document!.version;
    const r1 = await applyMerge(t.db, editor, prd.id, chunk.id, { baseVersion: v0, body: plan.groups[0]!.items[0]!.prefill });
    expect(r1).toMatchObject({ status: 'launched', done: 1, total: 4, moduleDocument: { id: moduleDoc.id, displayKey: 'PAN-PRD-2', version: v0 + 1 } });
    expect(await markdownOf(moduleDoc.id)).toBe('上传总述\n\n## 分片上传\n\n上传改为分片\n\n### 细节\n\n断点续传\n\n## 秒传\n\n秒传说明\n\n## 旧接口\n\n旧接口说明\n');
    const [rev] = await t.adminDb.select().from(documentRevisions).where(eq(documentRevisions.documentId, moduleDoc.id)).orderBy(asc(documentRevisions.version)).then((rows) => rows.slice(-1));
    expect(rev).toMatchObject({ summary: '合入 PAN-PRD-1：分片上传', mergedFromDocumentId: prd.id, authorMemberId: editor.memberId });
    expect(await mergeColumns(chunk.id)).toEqual({ status: 'applied', revisionId: rev!.id, by: editor.memberId, at: true });

    await expect(applyMerge(t.db, editor, prd.id, instant.id, { baseVersion: v0, body: '新的秒传' })).rejects.toMatchObject({
      code: 'conflict',
      message: '模块文档已被其他人修改，请刷新左侧内容后重试',
      details: { version: v0 + 1 },
    });
    await expect(applyMerge(t.db, editor, prd.id, instant.id, { baseVersion: v0 + 1, body: '正文\n## 新小节' })).rejects.toThrow('合入内容里不能有一级或二级标题');
    await applyMerge(t.db, editor, prd.id, instant.id, { baseVersion: v0 + 1, body: '断点续传，单文件最大 10 GB' });
    const r3 = await applyMerge(t.db, editor, prd.id, legacy.id, { baseVersion: v0 + 2, body: '应被忽略' });
    expect(r3).toMatchObject({ status: 'launched', done: 3, moduleDocument: { version: v0 + 3 } });
    expect(await markdownOf(moduleDoc.id)).toBe('上传总述\n\n## 分片上传\n\n上传改为分片\n\n### 细节\n\n断点续传\n\n## 秒传\n\n断点续传，单文件最大 10 GB\n');
    await expect(applyMerge(t.db, editor, prd.id, chunk.id, { baseVersion: v0 + 3, body: 'x' })).rejects.toThrow('这个功能点已处理');

    plan = await getMergePlan(t.db, editor, prd.id);
    expect(plan.groups[0]!.items.map((i) => [i.name, i.mergeStatus, i.mergedRevisionNumber, i.mergedBy?.displayName])).toEqual([
      ['分片上传', 'applied', 2, '编辑甲'],
      ['秒传', 'applied', 3, '编辑甲'],
      ['旧接口', 'applied', 4, '编辑甲'],
    ]);
    const events = await t.adminDb.select().from(domainEvents).where(eq(domainEvents.type, 'document.merged')).orderBy(asc(domainEvents.occurredAt));
    expect(events.map((e) => [e.subjectId, (e.payload as { changes: unknown }).changes])).toEqual([
      [moduleDoc.id, [{ field: 'section', old: null, new: '分片上传' }]],
      [moduleDoc.id, [{ field: 'section', old: '秒传', new: '秒传' }]],
      [moduleDoc.id, [{ field: 'section', old: '旧接口', new: null }]],
    ]);
  });

  it('跳过后全部处理完即为已合入；撤销跳过退回已上线；没有模块文档时自动新建；「PRD」检查项同步', async () => {
    const skipped = await skipMerge(t.db, editor, prd.id, offline.id);
    expect(skipped).toMatchObject({ status: 'merged', done: 4, total: 4, moduleDocument: null });
    expect(await mergeColumns(offline.id)).toEqual({ status: 'skipped', revisionId: null, by: editor.memberId, at: true });
    expect((await getDocument(t.db, owner, prd.id)).status).toBe('merged');
    expect(await getMergePlan(t.db, editor, prd.id)).toMatchObject({ canMerge: false, canReopen: true });

    const reopened = await reopenMerge(t.db, editor, prd.id, offline.id);
    expect(reopened).toMatchObject({ status: 'launched', done: 3, total: 4 });
    expect(await mergeColumns(offline.id)).toEqual({ status: 'pending', revisionId: null, by: null, at: false });
    expect((await getDocument(t.db, owner, prd.id)).status).toBe('launched');
    await expect(reopenMerge(t.db, editor, prd.id, chunk.id)).rejects.toThrow('只有已跳过的功能点可以撤销');

    // 模拟「PRD」检查项与 PRD 状态不一致，验证完成时同步
    await t.adminDb
      .update(checkItemResults)
      .set({ state: 'in_progress' })
      .where(and(eq(checkItemResults.targetType, 'requirement'), eq(checkItemResults.targetId, req.id), eq(checkItemResults.itemKey, 'prd')));
    const done = await applyMerge(t.db, editor, prd.id, offline.id, { baseVersion: null, body: '支持离线下载' });
    expect(done).toMatchObject({ status: 'merged', done: 4, total: 4, moduleDocument: { displayKey: 'PAN-PRD-3', version: 2 } });
    expect(await markdownOf(done.moduleDocument!.id)).toBe('## 离线下载\n\n支持离线下载\n');
    expect((await getDocument(t.db, owner, done.moduleDocument!.id)).node).toMatchObject({ id: download.id });
    expect(await prdState(req.id)).toBe('passed');
    const statusEvents = await t.adminDb
      .select()
      .from(domainEvents)
      .where(and(eq(domainEvents.type, 'document.status_changed'), eq(domainEvents.subjectId, prd.id)))
      .orderBy(asc(domainEvents.occurredAt));
    expect(statusEvents.slice(-3).map((e) => (e.payload as { changes: unknown }).changes)).toEqual([
      [{ field: 'status', old: 'launched', new: 'merged' }],
      [{ field: 'status', old: 'merged', new: 'launched' }],
      [{ field: 'status', old: 'launched', new: 'merged' }],
    ]);
    await expect(skipMerge(t.db, editor, prd.id, offline.id)).rejects.toThrow('只有已上线的 PRD 可以合入');
  });

  it('权限：只读成员与只读 Token 不能应用、跳过、撤销；不是变更 PRD、模块文档已归档时不能合入', async () => {
    const other = await createDocument(t.db, owner, pan, { title: '另一份' });
    const node = await createStructureNode(t.db, owner, pan, { parentId: upload.id, name: '回收站' });
    await addAffectedNode(t.db, owner, other.id, { nodeId: node.id, changeType: 'added' });
    for (const to of ['review', 'approved', 'launched'] as const) await transitionDocument(t.db, owner, other.id, { to });
    const version = (await getDocument(t.db, owner, moduleDoc.id)).version;
    await expect(applyMerge(t.db, viewer, other.id, node.id, { baseVersion: version, body: 'x' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(skipMerge(t.db, readOnlyToken(owner), other.id, node.id)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(reopenMerge(t.db, viewer, other.id, node.id)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(getMergePlan(t.db, owner, moduleDoc.id)).rejects.toThrow('模块文档没有影响声明');
    await transitionDocument(t.db, owner, moduleDoc.id, { to: 'archived' });
    await expect(applyMerge(t.db, owner, other.id, node.id, { baseVersion: version, body: 'x' })).rejects.toThrow('模块文档已归档');
    await transitionDocument(t.db, owner, moduleDoc.id, { to: 'active' });
    expect((await applyMerge(t.db, owner, other.id, node.id, { baseVersion: version, body: '回收站说明' })).status).toBe('merged');
  });
});
