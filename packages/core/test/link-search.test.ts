import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDocument, saveDocumentContent } from '../src/documents/documents';
import type { Actor } from '../src/domain-types';
import { createIteration } from '../src/iterations/iterations';
import { searchLinkTargets } from '../src/links/search';
import { createRequirement } from '../src/requirements/requirements';
import { createStructureNode } from '../src/structure/nodes';
import { createTask } from '../src/tasks/tasks';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, regularIteration, seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let guest: Actor;
let pan: string;
let doc: string;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  doc = (await createProduct(t.db, owner, { name: '文档', key: 'DOC' })).id;
  guest = await asMember(t.db, owner, '访客甲', 'guest');
  await setProductRole(t.db, owner, doc, guest.memberId, 'viewer');
  await createRequirement(t.db, owner, pan, { title: '登录改版' }); // PAN-1
  await createRequirement(t.db, owner, pan, { title: '上传提速' }); // PAN-2
  await createRequirement(t.db, owner, doc, { title: '登录日志' }); // DOC-1
  const prd = await createDocument(t.db, owner, pan, { title: '登录 PRD' }); // PAN-PRD-1
  await saveDocumentContent(t.db, owner, prd.id, { baseVersion: 1, markdown: '## 1. 背景\n\n现状\n\n## 2. 需求 说明\n\n内容\n\n## 3. 需求说明\n\n同名的第二个' });
  const sprint = await createIteration(t.db, owner, regularIteration(pan, '登录迭代', '2026-03-02', '2026-03-13'));
  await createTask(t.db, owner, { iterationId: sprint.id, title: '登录联调' }); // PAN-T-1
  await createIteration(t.db, owner, { type: 'special', name: '登录专项', startDate: '2026-03-02', endDate: '2026-03-20' });
  await createIteration(t.db, owner, regularIteration(pan, '登录[旧]', '2026-04-01', '2026-04-10'));
  const top = await createStructureNode(t.db, owner, pan, { name: '会员' });
  await createStructureNode(t.db, owner, pan, { parentId: top.id, name: '登录' });
});
afterAll(() => t.cleanup());

describe('[[ 补全搜索', () => {
  it('按标题关键词：依次为需求、PRD、任务、迭代、节点，本产品优先；写不进 [[ ]] 的名称不出现', async () => {
    const list = await searchLinkTargets(t.db, owner, { productId: pan, q: '登录' });
    expect(list.map((s) => [s.kind, s.insert, s.title, s.next])).toEqual([
      ['requirement', 'PAN-1', '登录改版', 'insert'],
      ['requirement', 'DOC-1', '登录日志', 'insert'],
      ['document', 'PAN-PRD-1', '登录 PRD', 'sections'],
      ['task', 'PAN-T-1', '登录联调', 'insert'],
      ['iteration', '迭代:登录迭代', '2026-03-02 ~ 2026-03-13', 'insert'],
      ['iteration', '迭代:登录专项', '2026-03-02 ~ 2026-03-20', 'insert'],
      ['structure_node', '会员/登录', '', 'insert'],
    ]);
  });

  it('从其他产品引用时，迭代与节点带上产品前缀；专项不带', async () => {
    const list = await searchLinkTargets(t.db, owner, { productId: doc, q: '登录' });
    expect(list.map((s) => s.insert)).toEqual(['DOC-1', 'PAN-1', 'PAN-PRD-1', 'PAN-T-1', 'PAN/迭代:登录迭代', '迭代:登录专项', 'PAN/会员/登录']);
  });

  it('按编号前缀（大小写不敏感，可以只输入一部分）；查询为空时只给本产品最近更新的需求与 PRD', async () => {
    expect((await searchLinkTargets(t.db, owner, { productId: pan, q: 'pan-2' })).map((s) => s.insert)).toEqual(['PAN-2']);
    expect((await searchLinkTargets(t.db, owner, { productId: pan, q: 'PAN-T-1' })).map((s) => s.insert)).toEqual(['PAN-T-1']);
    expect((await searchLinkTargets(t.db, owner, { productId: pan, q: 'pan-prd-1' })).map((s) => s.insert)).toEqual(['PAN-PRD-1']);
    expect((await searchLinkTargets(t.db, owner, { productId: pan, q: 'pan-prd' })).map((s) => s.insert)).toEqual(['PAN-PRD-1']);
    expect((await searchLinkTargets(t.db, owner, { productId: pan, q: '' })).map((s) => s.insert)).toEqual(['PAN-2', 'PAN-1', 'PAN-PRD-1']);
  });

  it('PRD 小节：先给「整篇」，再给当前正文的小节（归一化标题，同名只列第一个），可按小节标题筛选', async () => {
    const secs = await searchLinkTargets(t.db, owner, { productId: pan, q: 'PAN-PRD-1#' });
    expect(secs.map((s) => [s.kind, s.insert, s.title, s.hint, s.next])).toEqual([
      ['document', 'PAN-PRD-1', '登录 PRD', '整篇', 'insert'],
      ['section', 'PAN-PRD-1#背景', '1. 背景', null, 'insert'],
      ['section', 'PAN-PRD-1#需求说明', '2. 需求 说明', null, 'insert'],
    ]);
    expect((await searchLinkTargets(t.db, owner, { productId: pan, q: 'pan-prd-1#需求' })).map((s) => s.insert)).toEqual(['PAN-PRD-1', 'PAN-PRD-1#需求说明']);
  });

  it('只在能看到的产品里搜；需要来源产品的查看权限', async () => {
    expect((await searchLinkTargets(t.db, guest, { productId: doc, q: '登录' })).map((s) => s.insert)).toEqual(['DOC-1', '迭代:登录专项']);
    expect(await searchLinkTargets(t.db, guest, { productId: doc, q: 'PAN-PRD-1#' })).toEqual([]);
    await expect(searchLinkTargets(t.db, guest, { productId: pan, q: '登录' })).rejects.toMatchObject({ code: 'not_found' });
  });
});
