import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requirementAssignments, requirements } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import { createWorkflowTemplate, setProductWorkflowVersion } from '../src/definitions/workflows';
import type { Actor } from '../src/domain-types';
import { createRequirement } from '../src/requirements/requirements';
import { setCheckItemState, signCheckItem } from '../src/requirements/transitions';
import { listReviewQueue } from '../src/reviews/queue';
import { listFunctionTags } from '../src/tenancy/function-tags';
import { setMemberFunctionTags, updateMember } from '../src/tenancy/members';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, readOnlyToken, reviewWorkflow, seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let designer: Actor;
let boss: Actor;
let pan: string;
let doc: string;
let designTag: string;
const ids: Record<string, string> = {};
const assignDesigner = (requirementId: string, memberId: string) =>
  withOrg(t.db, owner.orgId, (tx) => tx.insert(requirementAssignments).values({ orgId: owner.orgId, requirementId, memberId, functionTagId: designTag }));
const waitingKeys = async (who: Actor) => (await listReviewQueue(t.db, who, pan, { waitingForMe: true })).rows.map((r) => r.displayKey);

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  doc = (await createProduct(t.db, owner, { name: '文档', key: 'DOC' })).id;
  designTag = (await listFunctionTags(t.db, owner)).find((x) => x.name === '设计')!.id;
  designer = await asMember(t.db, owner, '设计师甲');
  await setMemberFunctionTags(t.db, owner, designer.memberId, [designTag]);
  boss = await asMember(t.db, owner, '老板乙');
  await setProductRole(t.db, owner, pan, boss.memberId, 'viewer');
  const { version } = await createWorkflowTemplate(t.db, owner, { name: '评审流程', body: reviewWorkflow(designTag, boss.memberId) });
  await setProductWorkflowVersion(t.db, owner, pan, version.id);
  // PAN-1 未开始，PAN-2 评审中，PAN-3 有驳回，PAN-4 已通过，PAN-5 已上线（不在队列里）
  for (const title of ['未开始的需求', '评审中的需求', '被驳回的需求', '已通过的需求', '已上线的需求']) {
    ids[title] = (await createRequirement(t.db, owner, pan, { title })).id;
  }
  await createRequirement(t.db, owner, doc, { title: '文档需求' });
  await setCheckItemState(t.db, owner, ids['评审中的需求']!, 'feasibility', { state: 'passed' });
  await setCheckItemState(t.db, owner, ids['被驳回的需求']!, 'feasibility', { state: 'rejected' });
  const passed = ids['已通过的需求']!;
  await setCheckItemState(t.db, owner, passed, 'feasibility', { state: 'passed' });
  await setCheckItemState(t.db, owner, passed, 'prd', { state: 'not_needed' });
  await signCheckItem(t.db, designer, passed, 'design', { decision: 'passed' });
  await signCheckItem(t.db, boss, passed, 'design', { decision: 'passed' });
  await withOrg(t.db, owner.orgId, (tx) => tx.update(requirements).set({ stateKey: 'done' }).where(eq(requirements.id, ids['已上线的需求']!)));
});
afterAll(() => t.cleanup());

describe('评审队列', () => {
  it('列按流程检查项生成；默认列出未完成需求中评审没有全部通过的；统计按整体评审状态', async () => {
    const q = await listReviewQueue(t.db, owner, pan);
    expect(q.columns).toEqual([
      { key: 'feasibility', label: '可行性', type: 'single' },
      { key: 'design', label: '设计签字', type: 'signoff' },
      { key: 'prd', label: 'PRD', type: 'single' },
    ]);
    expect(q.stats).toEqual({ not_started: 1, in_progress: 1, rejected: 1, passed: 1 });
    expect(q.rows.map((r) => [r.displayKey, r.reviewState])).toEqual([
      ['PAN-3', 'rejected'],
      ['PAN-2', 'in_progress'],
      ['PAN-1', 'not_started'],
    ]);
    expect(q.rows[1]).toMatchObject({ title: '评审中的需求', state: { label: '收集' } });
    expect(q.rows[1]!.cells).toEqual({
      feasibility: { state: 'passed', passed: null, total: null },
      design: { state: 'not_started', passed: 0, total: 2 },
      prd: { state: 'not_started', passed: null, total: null },
    });
  });

  it('按整体状态与单个检查项的状态筛选，统计不受筛选影响', async () => {
    const passed = await listReviewQueue(t.db, owner, pan, { state: 'passed' });
    expect(passed.rows.map((r) => r.displayKey)).toEqual(['PAN-4']);
    expect(passed.stats).toEqual({ not_started: 1, in_progress: 1, rejected: 1, passed: 1 });
    expect((await listReviewQueue(t.db, owner, pan, { state: 'all' })).rows).toHaveLength(4);
    const feasible = await listReviewQueue(t.db, owner, pan, { state: 'all', itemKey: 'feasibility', itemState: 'passed' });
    expect(feasible.rows.map((r) => r.displayKey)).toEqual(['PAN-4', 'PAN-2']);
  });

  it('等我签字：评审已开始的需求上本人未签的规则；产品管理员可代签指定成员；签过后不再出现', async () => {
    const mine = await listReviewQueue(t.db, designer, pan, { waitingForMe: true });
    expect(mine.rows.map((r) => [r.displayKey, r.waiting])).toEqual([
      ['PAN-3', [{ itemKey: 'design', ruleIndex: 0, onBehalf: false }]],
      ['PAN-2', [{ itemKey: 'design', ruleIndex: 0, onBehalf: false }]],
    ]);
    const proxy = await listReviewQueue(t.db, owner, pan, { waitingForMe: true });
    expect(proxy.rows.map((r) => [r.displayKey, r.waiting])).toEqual([
      ['PAN-3', [{ itemKey: 'design', ruleIndex: 1, onBehalf: true }]],
      ['PAN-2', [{ itemKey: 'design', ruleIndex: 1, onBehalf: true }]],
    ]);
    await signCheckItem(t.db, designer, ids['评审中的需求']!, 'design', { decision: 'passed' });
    expect((await listReviewQueue(t.db, designer, pan, { waitingForMe: true })).rows.map((r) => r.displayKey)).toEqual(['PAN-3']);
    const row = (await listReviewQueue(t.db, boss, pan, { waitingForMe: true })).rows.find((r) => r.displayKey === 'PAN-2')!;
    expect(row.cells.design).toEqual({ state: 'in_progress', passed: 1, total: 2 });
    expect(row.waiting).toEqual([{ itemKey: 'design', ruleIndex: 1, onBehalf: false }]);
  });

  it('该谁签字就推给谁：被分配的设计看得到，没被分配的同标签成员看不到；没有分配时推给全部设计；评审没开始的不推', async () => {
    const other = await asMember(t.db, owner, '设计师丙');
    await setMemberFunctionTags(t.db, owner, other.memberId, [designTag]);
    // PAN-6：评审已开始，设计分配给设计师甲
    const assigned = (await createRequirement(t.db, owner, pan, { title: '指派了设计的需求' })).id;
    await setCheckItemState(t.db, owner, assigned, 'feasibility', { state: 'passed' });
    await assignDesigner(assigned, designer.memberId);
    // PAN-7：设计分配给设计师丙，但评审还没开始
    await assignDesigner((await createRequirement(t.db, owner, pan, { title: '评审没开始的需求' })).id, other.memberId);

    // 设计师甲：看到分配给他的 PAN-6；PAN-3 没有设计分配，回退为推给全部设计（PAN-2 他已经签过）
    expect(await waitingKeys(designer)).toEqual(['PAN-6', 'PAN-3']);
    // 设计师丙：同样持有设计标签，但 PAN-6 分配给了别人；PAN-7 分配给了他，但评审没开始，也不推
    expect(await waitingKeys(other)).toEqual(['PAN-3']);
  });

  it('分配给不持有标签的成员，或分配给离职成员：视同没有有效分配，回退为推给全部持有者', async () => {
    // PAN-8：设计分配给老板乙，但老板乙没有设计标签
    const noTag = await createRequirement(t.db, owner, pan, { title: '分配给不持有标签成员的需求' });
    await setCheckItemState(t.db, owner, noTag.id, 'feasibility', { state: 'passed' });
    await assignDesigner(noTag.id, boss.memberId);

    // PAN-9：设计分配给设计师戊，但她已离职
    const former = await asMember(t.db, owner, '设计师戊');
    await setMemberFunctionTags(t.db, owner, former.memberId, [designTag]);
    const left = await createRequirement(t.db, owner, pan, { title: '分配给离职成员的需求' });
    await setCheckItemState(t.db, owner, left.id, 'feasibility', { state: 'passed' });
    await assignDesigner(left.id, former.memberId);
    await updateMember(t.db, owner, former.memberId, { status: 'left' });

    const keys = await waitingKeys(designer);
    expect(keys).toEqual(expect.arrayContaining([noTag.displayKey, left.displayKey]));
  });

  it('只读 Token 可以查看但没有待签；看不到产品返回 404；流程没有检查项时返回空表', async () => {
    const ro = await listReviewQueue(t.db, readOnlyToken(owner), pan);
    expect(ro.rows.length).toBeGreaterThan(0);
    expect(ro.rows.every((r) => r.waiting.length === 0)).toBe(true);
    const outsider = await asMember(t.db, owner, '访客丙', 'guest');
    await expect(listReviewQueue(t.db, outsider, pan)).rejects.toMatchObject({ code: 'not_found' });
    expect(await listReviewQueue(t.db, owner, doc)).toEqual({ columns: [], stats: { not_started: 0, in_progress: 0, rejected: 0, passed: 0 }, rows: [] });
  });
});
