import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requirements } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import { addDocumentComment } from '../src/documents/comments';
import { createDocument, type DocumentDetail, saveDocumentContent } from '../src/documents/documents';
import type { Actor } from '../src/domain-types';
import { createIteration, deleteIteration, type IterationView } from '../src/iterations/iterations';
import { listBacklinks } from '../src/links/backlinks';
import { type LinkCard, listDocumentLinkCards } from '../src/links/cards';
import { addRequirementComment, listRequirementComments } from '../src/requirements/comments';
import { getRequirementByKey } from '../src/requirements/detail';
import type { StructureNodeView } from '../src/requirements/lookups';
import { createRequirement, type RequirementListItem, updateRequirement } from '../src/requirements/requirements';
import { createStructureNode } from '../src/structure/nodes';
import { createTask, deleteTask, type TaskView } from '../src/tasks/tasks';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, regularIteration, seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let guest: Actor;
let pan: string;
let doc: string;
let loginReq: RequirementListItem;
let docReq: RequirementListItem;
let prd: DocumentDetail;
let sprint: IterationView;
let task: TaskView;
let node: StructureNodeView;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  doc = (await createProduct(t.db, owner, { name: '文档', key: 'DOC' })).id;
  guest = await asMember(t.db, owner, '访客甲', 'guest');
  await setProductRole(t.db, owner, pan, guest.memberId, 'viewer');
  loginReq = await createRequirement(t.db, owner, pan, { title: '登录改版' }); // PAN-1
  docReq = await createRequirement(t.db, owner, doc, { title: '文档保密需求' }); // DOC-1
  prd = await createDocument(t.db, owner, pan, { title: '登录 PRD' }); // PAN-PRD-1
  await saveDocumentContent(t.db, owner, prd.id, { baseVersion: 1, markdown: '## 1. 背景\n\n现状\n\n## 2. 需求 说明\n\n内容' });
  sprint = await createIteration(t.db, owner, regularIteration(pan, '迭代0316', '2026-03-02', '2026-03-13'));
  task = await createTask(t.db, owner, { iterationId: sprint.id, title: '登录联调' }); // PAN-T-1
  const top = await createStructureNode(t.db, owner, pan, { name: '会员' });
  node = await createStructureNode(t.db, owner, pan, { parentId: top.id, name: '登录' });
});
afterAll(() => t.cleanup());

const byText = (cards: LinkCard[]) => Object.fromEntries(cards.map((c) => [c.text, c]));

describe('链接卡', () => {
  it('当前编号、标题与状态；悬空；小节有效与失效；跨产品无权限时只显示编号', async () => {
    const src = await createRequirement(t.db, owner, pan, {
      title: '引用方',
      description: '[[PAN-1|登录]] [[PAN-PRD-1#需求说明]] [[PAN-PRD-1#方案]] [[PAN-T-1]] [[迭代:迭代0316]] [[会员/登录]] [[DOC-1]] [[PAN-99]]',
    });
    const cards = byText((await getRequirementByKey(t.db, owner, src.displayKey)).links);
    expect(cards['PAN-1']).toEqual({
      text: 'PAN-1',
      targetType: 'requirement',
      state: 'ok',
      displayKey: 'PAN-1',
      title: '登录改版',
      status: { label: '待处理', color: '#94a3b8' },
      href: 'requirements/PAN-1',
    });
    expect(cards['PAN-PRD-1#需求说明']).toMatchObject({
      state: 'ok',
      displayKey: 'PAN-PRD-1#需求说明',
      title: '登录 PRD',
      status: { label: '草稿' },
      href: 'documents/PAN-PRD-1?section=%E9%9C%80%E6%B1%82%E8%AF%B4%E6%98%8E',
    });
    expect(cards['PAN-PRD-1#方案']).toMatchObject({ state: 'section_missing', displayKey: 'PAN-PRD-1#方案', href: 'documents/PAN-PRD-1' });
    expect(cards['PAN-T-1']).toMatchObject({ state: 'ok', displayKey: 'PAN-T-1', title: '登录联调', status: { label: '待开始' }, href: 'tasks/PAN-T-1' });
    expect(cards['PAN/迭代:迭代0316']).toMatchObject({ state: 'ok', displayKey: '迭代:迭代0316', status: { label: '规划中' }, href: `iterations/${sprint.id}` });
    expect(cards['PAN/会员/登录']).toMatchObject({ state: 'ok', displayKey: '会员/登录', href: `requirements?product=PAN&node=${node.id}` });
    expect(cards['DOC-1']).toMatchObject({ state: 'ok', title: '文档保密需求' });
    expect(cards['PAN-99']).toEqual({ text: 'PAN-99', targetType: 'requirement', state: 'missing', displayKey: 'PAN-99', title: null, status: null, href: null });

    const forGuest = byText((await getRequirementByKey(t.db, guest, src.displayKey)).links);
    expect(forGuest['DOC-1']).toEqual({ text: 'DOC-1', targetType: 'requirement', state: 'hidden', displayKey: 'DOC-1', title: null, status: null, href: null });
    expect(forGuest['PAN-1']!.title).toBe('登录改版');
  });

  it('目标改标题后链接不断；删除、取消后显示为已删除、已取消', async () => {
    const victim = await createRequirement(t.db, owner, pan, { title: '将被取消' });
    const gone = await createRequirement(t.db, owner, pan, { title: '将被删除' });
    const tmp = await createTask(t.db, owner, { iterationId: sprint.id, title: '将被删除的任务' });
    const src = await createRequirement(t.db, owner, pan, { title: '引用方二', description: `[[${victim.displayKey}]] [[${gone.displayKey}]] [[${tmp.displayKey}]] [[PAN-1]]` });
    await updateRequirement(t.db, owner, loginReq.id, { title: '登录改版二期' });
    await withOrg(t.db, owner.orgId, (tx) => tx.update(requirements).set({ stateKey: 'canceled' }).where(eq(requirements.id, victim.id)));
    await withOrg(t.db, owner.orgId, (tx) => tx.update(requirements).set({ deletedAt: new Date() }).where(eq(requirements.id, gone.id)));
    await deleteTask(t.db, owner, tmp.id);
    const cards = byText((await getRequirementByKey(t.db, owner, src.displayKey)).links);
    expect(cards['PAN-1']!.title).toBe('登录改版二期');
    expect(cards[victim.displayKey]).toMatchObject({ state: 'canceled', status: { label: '已取消' }, href: `requirements/${victim.displayKey}` });
    expect(cards[gone.displayKey]).toMatchObject({ state: 'deleted', href: null });
    expect(cards[tmp.displayKey]).toMatchObject({ state: 'deleted', title: null, href: null });
  });

  it('迭代删除后来源再保存，链接卡显示已删除', async () => {
    const doomed = await createIteration(t.db, owner, regularIteration(pan, '待删迭代', '2026-04-06', '2026-04-17'));
    const src = await createRequirement(t.db, owner, pan, { title: '引用方三', description: '[[迭代:待删迭代]]' });
    await deleteIteration(t.db, owner, doomed.id);
    await updateRequirement(t.db, owner, src.id, { description: '排期 [[迭代:待删迭代]]' });
    const cards = byText((await getRequirementByKey(t.db, owner, src.displayKey)).links);
    expect(cards['PAN/迭代:待删迭代']).toMatchObject({ state: 'deleted', href: null });
  });

  it('评论的链接卡随评论返回；PRD 正文的链接卡单独读取', async () => {
    const c = await addRequirementComment(t.db, owner, loginReq.id, { body: '参考 [[PAN-PRD-1]]' });
    expect(c.links).toMatchObject([{ text: 'PAN-PRD-1', state: 'ok', title: '登录 PRD' }]);
    expect((await listRequirementComments(t.db, owner, loginReq.id)).find((x) => x.id === c.id)!.links).toHaveLength(1);
    const dc = await addDocumentComment(t.db, owner, prd.id, { body: '对应 [[PAN-T-1]]' });
    expect(dc.links).toMatchObject([{ text: 'PAN-T-1', state: 'ok' }]);
    expect(await listDocumentLinkCards(t.db, owner, prd.id)).toEqual([]);
    await saveDocumentContent(t.db, owner, prd.id, { baseVersion: prd.version + 1, markdown: '## 1. 背景\n\n见 [[PAN-T-1]]\n\n## 2. 需求 说明\n\n内容' });
    expect(await listDocumentLinkCards(t.db, owner, prd.id)).toMatchObject([{ text: 'PAN-T-1', state: 'ok' }]);
  });
});

describe('「被引用」', () => {
  it('按来源对象分组：需求描述、PRD 小节、评论；看不到的来源不列出；不列自己；看不到目标时 404', async () => {
    const target = await createTask(t.db, owner, { iterationId: sprint.id, title: '被引用的任务' });
    const a = await createRequirement(t.db, owner, pan, { title: '描述引用', description: `依赖 [[${target.displayKey}]] 的联调。` });
    const d = await createDocument(t.db, owner, pan, { title: '正文引用' });
    await saveDocumentContent(t.db, owner, d.id, { baseVersion: 1, markdown: `## 1. 方案\n\n联调见 [[${target.displayKey}]]。` });
    await addRequirementComment(t.db, owner, a.id, { body: `再提一次 [[${target.displayKey}]]` });
    const hiddenSrc = await createRequirement(t.db, owner, doc, { title: '另一个产品里的引用', description: `[[${target.displayKey}]]` });

    const groups = await listBacklinks(t.db, owner, { type: 'task', id: target.id });
    expect(groups.map((g) => [g.kind, g.displayKey, g.href, g.items.map((i) => [i.via, i.section, i.context])])).toEqual([
      ['requirement', hiddenSrc.displayKey, `requirements/${hiddenSrc.displayKey}`, [['description', null, `[[${target.displayKey}]]`]]],
      ['requirement', a.displayKey, `requirements/${a.displayKey}`, [['comment', null, `再提一次 [[${target.displayKey}]]`], ['description', null, `依赖 [[${target.displayKey}]] 的联调。`]]],
      ['document', d.displayKey, `documents/${d.displayKey}`, [['body', '1. 方案', `联调见 [[${target.displayKey}]]。`]]],
    ]);
    expect(groups[1]!.items[0]!.createdAt).toBeInstanceOf(Date);
    expect((await listBacklinks(t.db, guest, { type: 'task', id: target.id })).map((g) => g.displayKey)).toEqual([a.displayKey, d.displayKey]);

    await updateRequirement(t.db, owner, a.id, { description: `自己 [[${a.displayKey}]]` });
    expect(await listBacklinks(t.db, owner, { type: 'requirement', id: a.id })).toEqual([]);
    await expect(listBacklinks(t.db, guest, { type: 'requirement', id: docReq.id })).rejects.toMatchObject({ code: 'not_found', message: '需求不存在' });
    await expect(listBacklinks(t.db, owner, { type: 'iteration', id: sprint.id })).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'requirement', title: '引用方' })]),
    );
  });
});
