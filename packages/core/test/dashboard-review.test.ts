import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadProductFlow } from '../src/dashboard/flow';
import { loadReviewEvents, stateChangeOf } from '../src/dashboard/review';
import { documents, requirements } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import { createWorkflowTemplate, setProductWorkflowVersion } from '../src/definitions/workflows';
import type { Actor } from '../src/domain-types';
import { signDocumentCheckItem } from '../src/documents/checks';
import { createDocument } from '../src/documents/documents';
import { createRequirement } from '../src/requirements/requirements';
import { setCheckItemState, signCheckItem } from '../src/requirements/transitions';
import { listFunctionTags } from '../src/tenancy/function-tags';
import { setMemberFunctionTags } from '../src/tenancy/members';
import { createProduct } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, prdWorkflow, reviewWorkflow, seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let pan: string;
let wiki: string;
let q1: string;
let q2: string;
let liveDoc: string;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  const designTag = (await listFunctionTags(t.db, owner)).find((x) => x.name === '设计')!.id;
  const designer = await asMember(t.db, owner, '设计师甲');
  await setMemberFunctionTags(t.db, owner, designer.memberId, [designTag]);
  await setMemberFunctionTags(t.db, owner, owner.memberId, [designTag]);
  const boss = await asMember(t.db, owner, '老板乙');
  const { version } = await createWorkflowTemplate(t.db, owner, { name: '评审流程', body: reviewWorkflow(designTag, boss.memberId) });
  const prd = await createWorkflowTemplate(t.db, owner, { name: 'PRD 流程', body: prdWorkflow(designTag) });
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  const doc = (await createProduct(t.db, owner, { name: '文档', key: 'DOC' })).id;
  wiki = (await createProduct(t.db, owner, { name: '知识库', key: 'WIKI' })).id;
  await setProductWorkflowVersion(t.db, owner, pan, version.id);
  await setProductWorkflowVersion(t.db, owner, doc, version.id);
  await setProductWorkflowVersion(t.db, owner, wiki, prd.version.id);
  q1 = (await createRequirement(t.db, owner, pan, { title: '需求一' })).id;
  q2 = (await createRequirement(t.db, owner, pan, { title: '需求二' })).id;
  const q3 = (await createRequirement(t.db, owner, pan, { title: '之后删除的需求' })).id;
  const o1 = (await createRequirement(t.db, owner, doc, { title: '文档需求' })).id;
  await setCheckItemState(t.db, owner, q1, 'feasibility', { state: 'rejected' });
  await setCheckItemState(t.db, owner, q1, 'feasibility', { state: 'passed', note: '补充了数据' });
  // 两条签字规则只签了一条：状态从未开始变为评审中
  await signCheckItem(t.db, designer, q1, 'design', { decision: 'passed' });
  await setCheckItemState(t.db, owner, q2, 'prd', { state: 'not_needed' });
  await setCheckItemState(t.db, owner, q3, 'feasibility', { state: 'passed' });
  await setCheckItemState(t.db, owner, o1, 'feasibility', { state: 'passed' });
  await t.adminDb.update(requirements).set({ deletedAt: new Date() }).where(eq(requirements.id, q3));

  liveDoc = (await createDocument(t.db, owner, wiki, { title: '在用 PRD', externalUrl: 'https://doc.weixin.qq.com/doc/live' })).id;
  const goneDoc = (await createDocument(t.db, owner, wiki, { title: '之后删除的 PRD', externalUrl: 'https://doc.weixin.qq.com/doc/gone' })).id;
  await signDocumentCheckItem(t.db, owner, liveDoc, 'prd_review', { decision: 'passed' });
  await signDocumentCheckItem(t.db, owner, goneDoc, 'prd_review', { decision: 'rejected' });
  await t.adminDb.update(documents).set({ deletedAt: new Date() }).where(eq(documents.id, goneDoc));
});
afterAll(() => t.cleanup());

describe('读取检查项事件', () => {
  it('只读本产品、对象未删除的检查项事件，按时间升序，带出状态新值与签字结论', async () => {
    const events = await withOrg(t.db, owner.orgId, async (tx) => loadReviewEvents(tx, pan, new Set((await loadProductFlow(tx, pan, 'Asia/Shanghai')).meta.keys())));
    const name = (id: string) => (id === q1 ? 'q1' : id === q2 ? 'q2' : id);
    expect(events.map((e) => [name(e.subjectId), e.subjectType, e.itemKey, e.type, e.newState, e.decision])).toEqual([
      ['q1', 'requirement', 'feasibility', 'check_item.updated', 'rejected', null],
      ['q1', 'requirement', 'feasibility', 'check_item.updated', 'passed', null],
      ['q1', 'requirement', 'design', 'check_item.signed', 'in_progress', 'passed'],
      ['q2', 'requirement', 'prd', 'check_item.updated', 'not_needed', null],
    ]);
  });

  it('PRD 上的检查项事件也读取，已删除的 PRD 上的不返回', async () => {
    const events = await withOrg(t.db, owner.orgId, async (tx) => loadReviewEvents(tx, wiki, new Set()));
    expect(events.map((e) => [e.subjectId === liveDoc ? 'live' : e.subjectId, e.subjectType, e.itemKey, e.type, e.newState, e.decision])).toEqual([
      ['live', 'document', 'prd_review', 'check_item.signed', 'passed', 'passed'],
    ]);
  });

  it('状态新值只取 field 为 state 的变化', () => {
    expect(stateChangeOf({ changes: [{ field: 'state', old: 'not_started', new: 'passed' }] })).toBe('passed');
    expect(stateChangeOf({ changes: [{ field: 'note', old: null, new: '说明' }] })).toBeNull();
    expect(stateChangeOf({ changes: [] })).toBeNull();
    expect(stateChangeOf({})).toBeNull();
  });
});
