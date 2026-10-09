import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { entityAliases, entityLinks } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import { addDocumentComment } from '../src/documents/comments';
import { convertExternalDocument, createDocument, type DocumentDetail, restoreRevision, saveDocumentContent } from '../src/documents/documents';
import type { Actor } from '../src/domain-types';
import { createIteration, type IterationView, updateIteration } from '../src/iterations/iterations';
import type { LinkSourceType } from '../src/links/syntax';
import { addRequirementComment } from '../src/requirements/comments';
import { createRequirement, type RequirementListItem, updateRequirement } from '../src/requirements/requirements';
import type { StructureNodeView } from '../src/requirements/lookups';
import { createStructureNode, moveStructureNode, updateStructureNode } from '../src/structure/nodes';
import { createTask, type TaskView } from '../src/tasks/tasks';
import { createProduct } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, regularIteration, seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let editor: Actor;
let pan: string;
let doc: string;
let login: RequirementListItem;
let docReq: RequirementListItem;
let prd: DocumentDetail;
let sprint: IterationView;
let special: IterationView;
let task: TaskView;
let pay: StructureNodeView;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  editor = await asMember(t.db, owner, '编辑乙');
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  doc = (await createProduct(t.db, owner, { name: '文档', key: 'DOC' })).id;
  login = await createRequirement(t.db, owner, pan, { title: '登录改版' }); // PAN-1
  docReq = await createRequirement(t.db, owner, doc, { title: '文档需求' }); // DOC-1
  prd = await createDocument(t.db, owner, pan, { title: '登录 PRD' }); // PAN-PRD-1
  sprint = await createIteration(t.db, owner, regularIteration(pan, '迭代0316', '2026-03-02', '2026-03-13'));
  special = await createIteration(t.db, owner, { type: 'special', name: '专项一', startDate: '2026-03-02', endDate: '2026-03-20' });
  task = await createTask(t.db, owner, { iterationId: sprint.id, title: '登录联调' }); // PAN-T-1
  const top = await createStructureNode(t.db, owner, pan, { name: '会员' });
  pay = await createStructureNode(t.db, owner, pan, { parentId: top.id, name: '支付' });
  await withOrg(t.db, owner.orgId, (tx) => tx.insert(entityAliases).values({ orgId: owner.orgId, entityType: 'requirement', entityId: login.id, alias: 'X2026' }));
});
afterAll(() => t.cleanup());

const linksOf = (type: LinkSourceType, id: string) =>
  withOrg(t.db, owner.orgId, (tx) =>
    tx
      .select()
      .from(entityLinks)
      .where(and(eq(entityLinks.sourceType, type), eq(entityLinks.sourceId, id)))
      .orderBy(asc(entityLinks.targetText)),
  );

describe('链接写入', () => {
  it('需求描述：新建与修改描述时解析并重建；各类目标、旧编号、悬空、去重、上下文；代码里的不算', async () => {
    const src = await createRequirement(t.db, owner, pan, {
      title: '引用方',
      description:
        '依赖 [[PAN-1]] 与 [[pan-1|登录]]。文档见 [[PAN-PRD-1#需求说明]]，任务 [[PAN-T-1]]。\n排期 [[迭代:迭代0316]]、[[迭代:专项一]]，模块 [[会员/支付]]，旧编号 [[X2026]]，跨产品 [[DOC-1]]，还没有的 [[PAN-99]]。`[[PAN-2]]` 不算。',
    });
    const rows = await linksOf('requirement', src.id);
    expect(Object.fromEntries(rows.map((r) => [r.targetText, [r.targetType, r.targetId, r.targetSection]]))).toEqual({
      'PAN-1': ['requirement', login.id, null],
      'PAN-PRD-1#需求说明': ['document', prd.id, '需求说明'],
      'PAN-T-1': ['task', task.id, null],
      'PAN/迭代:迭代0316': ['iteration', sprint.id, null],
      'PAN/迭代:专项一': ['iteration', special.id, null],
      'PAN/会员/支付': ['structure_node', pay.id, null],
      'PAN/X2026': ['requirement', login.id, null],
      'DOC-1': ['requirement', docReq.id, null],
      'PAN-99': ['requirement', null, null],
    });
    expect(rows.find((r) => r.targetText === 'PAN-1')).toMatchObject({ context: '依赖 [[PAN-1]] 与 [[pan-1|登录]]。', sourceSection: null, origin: 'wikilink' });
    const kept = rows.find((r) => r.targetText === 'PAN-T-1')!.createdAt;

    await updateRequirement(t.db, owner, src.id, { description: '只剩 [[PAN-T-1]]' });
    const after = await linksOf('requirement', src.id);
    expect(after.map((r) => r.targetText)).toEqual(['PAN-T-1']);
    expect(after[0]!.createdAt).toEqual(kept);
    await updateRequirement(t.db, owner, src.id, { title: '只改标题' });
    expect(await linksOf('requirement', src.id)).toHaveLength(1);
  });

  it('PRD 正文：保存、恢复、转为 Flower 文档时重建；记录所在小节', async () => {
    const d = await createDocument(t.db, owner, pan, { title: '引用 PRD' });
    await saveDocumentContent(t.db, owner, d.id, {
      baseVersion: 1,
      markdown: '开头 [[PAN-1]]\n\n## 1. 背景\n\n见 [[PAN-1]]\n\n```\n[[PAN-T-1]]\n```\n\n## 2. 方案\n\n[[迭代:迭代0316]]',
    });
    const rows = (await linksOf('document', d.id)).map((r) => [r.sourceSection, r.targetText]);
    expect(rows).toHaveLength(3);
    expect(rows).toEqual(expect.arrayContaining([[null, 'PAN-1'], ['1. 背景', 'PAN-1'], ['2. 方案', 'PAN/迭代:迭代0316']]));
    // 换一个作者保存，避免与上一次保存合并为同一条修订
    await saveDocumentContent(t.db, editor, d.id, { baseVersion: 2, markdown: '## 1. 背景\n\n没有引用' });
    expect(await linksOf('document', d.id)).toHaveLength(0);
    await restoreRevision(t.db, owner, d.id, { number: 1, baseVersion: 3 });
    expect(await linksOf('document', d.id)).toHaveLength(3);
    const ext = await createDocument(t.db, owner, pan, { title: '外部', externalUrl: 'https://docs.qq.com/doc/links' });
    await convertExternalDocument(t.db, owner, ext.id, { baseVersion: 1, markdown: '转换后引用 [[DOC-1]]' });
    expect((await linksOf('document', ext.id)).map((r) => r.targetText)).toEqual(['DOC-1']);
  });

  it('评论：需求评论与 PRD 评论新建时写链接', async () => {
    const c = await addRequirementComment(t.db, owner, login.id, { body: '参考 [[PAN-PRD-1]]' });
    expect(await linksOf('comment', c.id)).toMatchObject([{ targetType: 'document', targetId: prd.id, targetText: 'PAN-PRD-1', targetSection: null, context: '参考 [[PAN-PRD-1]]' }]);
    const dc = await addDocumentComment(t.db, editor, prd.id, { body: '对应 [[PAN-T-1]]' });
    expect(await linksOf('comment', dc.id)).toMatchObject([{ targetType: 'task', targetId: task.id }]);
  });

  it('旧编号不区分大小写', async () => {
    await withOrg(t.db, owner.orgId, (tx) => tx.insert(entityAliases).values({ orgId: owner.orgId, entityType: 'requirement', entityId: login.id, alias: 'push-12' }));
    const src = await createRequirement(t.db, owner, pan, { title: '大写旧编号', description: '[[PUSH-12]]' });
    expect(await linksOf('requirement', src.id)).toMatchObject([{ targetType: 'requirement', targetId: login.id }]);
  });
});

describe('悬空链接自动接上', () => {
  let neo: string;
  beforeAll(async () => {
    neo = (await createProduct(t.db, owner, { name: '新产品', key: 'NEW' })).id;
  });
  const targetIds = async (sourceId: string) => Object.fromEntries((await linksOf('requirement', sourceId)).map((x) => [x.targetText, x.targetId]));

  it('新建需求、PRD（含指向小节的链接）、任务、迭代（含专项）、节点后接上', async () => {
    const src = await createRequirement(t.db, owner, pan, {
      title: '先引用后创建',
      description: '[[NEW-1]] [[NEW-PRD-1]] [[NEW-PRD-1#方案]] [[NEW-T-1]] [[NEW/迭代:一期]] [[NEW/会员/支付]] [[迭代:新专项]]',
    });
    expect(Object.values(await targetIds(src.id)).every((id) => id === null)).toBe(true);
    const r = await createRequirement(t.db, owner, neo, { title: '后建需求' });
    const d = await createDocument(t.db, owner, neo, { title: '后建 PRD' });
    const it1 = await createIteration(t.db, owner, regularIteration(neo, '一期', '2026-11-02', '2026-11-13'));
    const later = await createTask(t.db, owner, { iterationId: it1.id, title: '后建任务' });
    const top = await createStructureNode(t.db, owner, neo, { name: '会员' });
    const leaf = await createStructureNode(t.db, owner, neo, { parentId: top.id, name: '支付' });
    const sp = await createIteration(t.db, owner, { type: 'special', name: '新专项', startDate: '2026-11-02', endDate: '2026-11-20' });
    expect(await targetIds(src.id)).toEqual({
      'NEW-1': r.id,
      'NEW-PRD-1': d.id,
      'NEW-PRD-1#方案': d.id,
      'NEW-T-1': later.id,
      'NEW/迭代:一期': it1.id,
      'NEW/会员/支付': leaf.id,
      'PAN/迭代:新专项': sp.id,
    });
  });

  it('迭代改名、节点改名或移动后按新的写法接上；已接上的链接不受改名影响', async () => {
    const it2 = await createIteration(t.db, owner, regularIteration(neo, '二期', '2026-11-16', '2026-11-27'));
    const growth = await createStructureNode(t.db, owner, neo, { name: '增长中心' });
    const child = await createStructureNode(t.db, owner, neo, { parentId: growth.id, name: '拉新' });
    const oldDomain = await createStructureNode(t.db, owner, neo, { name: '旧域' });
    const moved = await createStructureNode(t.db, owner, neo, { parentId: oldDomain.id, name: '模块甲' });
    const newDomain = await createStructureNode(t.db, owner, neo, { name: '新域' });
    const src = await createRequirement(t.db, owner, pan, { title: '改名前后', description: '[[NEW/迭代:二期]] [[NEW/迭代:三期]] [[NEW/增长/拉新]] [[NEW/新域/模块甲]]' });
    expect(await targetIds(src.id)).toEqual({ 'NEW/迭代:二期': it2.id, 'NEW/迭代:三期': null, 'NEW/增长/拉新': null, 'NEW/新域/模块甲': null });
    await updateIteration(t.db, owner, it2.id, { name: '三期' });
    await updateStructureNode(t.db, owner, growth.id, { name: '增长' });
    await moveStructureNode(t.db, owner, moved.id, { parentId: newDomain.id });
    expect(await targetIds(src.id)).toEqual({ 'NEW/迭代:二期': it2.id, 'NEW/迭代:三期': it2.id, 'NEW/增长/拉新': child.id, 'NEW/新域/模块甲': moved.id });
  });

  it('迭代或节点改名后，来源按原文再保存，链接仍指向原目标', async () => {
    const it4 = await createIteration(t.db, owner, regularIteration(neo, '四期', '2026-12-01', '2026-12-11'));
    const ops = await createStructureNode(t.db, owner, neo, { name: '运营' });
    const src = await createRequirement(t.db, owner, pan, { title: '改名后重存', description: '[[NEW/迭代:四期]] [[NEW/运营]]' });
    await updateIteration(t.db, owner, it4.id, { name: '四期改' });
    await updateStructureNode(t.db, owner, ops.id, { name: '运营中心' });
    await updateRequirement(t.db, owner, src.id, { description: '排期 [[NEW/迭代:四期]] [[NEW/运营]]' });
    expect(await targetIds(src.id)).toEqual({ 'NEW/迭代:四期': it4.id, 'NEW/运营': ops.id });
    const rows = await linksOf('requirement', src.id);
    expect(Object.fromEntries(rows.map((r) => [r.targetText, r.targetType]))).toEqual({ 'NEW/迭代:四期': 'iteration', 'NEW/运营': 'structure_node' });
  });
});
