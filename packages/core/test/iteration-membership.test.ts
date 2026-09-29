import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { domainEvents } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import { createWorkflowTemplate, setProductWorkflowVersion } from '../src/definitions/workflows';
import type { Actor } from '../src/domain-types';
import { createIteration, getIteration, getIterationScope, type IterationView, setIterationStatus } from '../src/iterations/iterations';
import { setRequirementIteration } from '../src/iterations/membership';
import { getRequirementByKey } from '../src/requirements/detail';
import { createRequirement, type RequirementListItem } from '../src/requirements/requirements';
import { setCheckItemState } from '../src/requirements/transitions';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, GATED_WORKFLOW, readOnlyToken, regularIteration, seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let pm: Actor;
let editor: Actor;
let viewer: Actor;
let readToken: Actor;
let pan: string;
let doc: string;
let planning: IterationView;
let active: IterationView;
let finished: IterationView;
let canceled: IterationView;
let docIteration: IterationView;
let special: IterationView;
let base: RequirementListItem;
let r: RequirementListItem;

const UNMET = '「可行性」需为通过（当前：未开始）';
const iterationEvents = (requirementId: string) =>
  withOrg(t.db, owner.orgId, (tx) =>
    tx.select().from(domainEvents).where(and(eq(domainEvents.subjectId, requirementId), eq(domainEvents.type, 'requirement.iteration_changed'))),
  );

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  doc = (await createProduct(t.db, owner, { name: '文档', key: 'DOC' })).id;
  pm = await asMember(t.db, owner, '产品经理甲');
  await setProductRole(t.db, owner, pan, pm.memberId, 'admin');
  editor = await asMember(t.db, owner, '开发乙');
  viewer = await asMember(t.db, owner, '只读丙');
  await setProductRole(t.db, owner, pan, viewer.memberId, 'viewer');
  readToken = readOnlyToken(owner);
  const { version } = await createWorkflowTemplate(t.db, owner, { name: '准入流程', body: GATED_WORKFLOW });
  await setProductWorkflowVersion(t.db, owner, pan, version.id);
  planning = await createIteration(t.db, owner, regularIteration(pan, '迭代0701', '2026-07-01', '2026-07-14'));
  active = await createIteration(t.db, owner, regularIteration(pan, '迭代0715', '2026-07-15', '2026-07-28'));
  finished = await createIteration(t.db, owner, regularIteration(pan, '迭代0601', '2026-06-01', '2026-06-14'));
  canceled = await createIteration(t.db, owner, regularIteration(pan, '迭代0501', '2026-05-01', '2026-05-14'));
  docIteration = await createIteration(t.db, owner, regularIteration(doc, '文档迭代', '2026-07-01', '2026-07-14'));
  special = await createIteration(t.db, owner, { type: 'special', name: '专业空间优化', startDate: '2026-07-01', endDate: '2026-09-30' });
  base = await createRequirement(t.db, owner, pan, { title: '开始前已承诺的需求' });
  await setRequirementIteration(t.db, owner, base.id, { iterationId: active.id, force: true, reason: '测试准备' });
  await setIterationStatus(t.db, owner, active.id, 'active');
  await setIterationStatus(t.db, owner, finished.id, 'active');
  await setIterationStatus(t.db, owner, finished.id, 'done');
  await setIterationStatus(t.db, owner, canceled.id, 'canceled');
  r = await createRequirement(t.db, owner, pan, { title: '分享链接有效期' });
});
afterAll(() => t.cleanup());

describe('加入迭代的准入条件', () => {
  it('条件不满足时拒绝加入并给出原因；需求详情给出同样的原因', async () => {
    await expect(setRequirementIteration(t.db, editor, r.id, { iterationId: planning.id })).rejects.toMatchObject({
      code: 'precondition_failed',
      message: '加入迭代的条件未满足',
      details: { unmet: [UNMET] },
    });
    const d = await getRequirementByKey(t.db, editor, r.displayKey);
    expect(d.joinIterationUnmet.map((u) => u.message)).toEqual([UNMET]);
    expect(d.iteration).toBeNull();
  });

  it('条件满足后可以加入，并记录事件；再次加入同一迭代没有变化', async () => {
    await setCheckItemState(t.db, editor, r.id, 'feasibility', { state: 'passed' });
    expect((await getRequirementByKey(t.db, editor, r.displayKey)).joinIterationUnmet).toEqual([]);
    expect(await setRequirementIteration(t.db, editor, r.id, { iterationId: planning.id })).toEqual({ iteration: { id: planning.id, name: '迭代0701' } });
    expect((await getRequirementByKey(t.db, editor, r.displayKey)).iteration).toEqual({ id: planning.id, name: '迭代0701' });
    expect(await setRequirementIteration(t.db, editor, r.id, { iterationId: planning.id })).toEqual({ iteration: { id: planning.id, name: '迭代0701' } });
    const events = await iterationEvents(r.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ changes: [{ field: 'iterationId', old: null, new: planning.id }], iterationName: '迭代0701', forced: false, reason: null });
  });

  it('只读成员和只读 Token 不能加入或移出', async () => {
    await expect(setRequirementIteration(t.db, viewer, r.id, { iterationId: null })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(setRequirementIteration(t.db, readToken, r.id, { iterationId: null })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(setRequirementIteration(t.db, readToken, r.id, { iterationId: active.id })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('强制加入只允许产品管理员，必须填写原因，原因记入事件', async () => {
    const s = await createRequirement(t.db, owner, pan, { title: '未评估的紧急需求' });
    await expect(setRequirementIteration(t.db, editor, s.id, { iterationId: active.id, force: true, reason: '线上问题' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(setRequirementIteration(t.db, pm, s.id, { iterationId: active.id, force: true, reason: '   ' })).rejects.toMatchObject({ code: 'invalid' });
    await setRequirementIteration(t.db, pm, s.id, { iterationId: active.id, force: true, reason: '线上问题必须本迭代修复' });
    const [ev] = await iterationEvents(s.id);
    expect(ev!.payload).toMatchObject({ forced: true, reason: '线上问题必须本迭代修复' });
    const scope = await getIterationScope(t.db, owner, active.id);
    expect(scope.committedOpen.map((x) => x.title)).toEqual(['开始前已承诺的需求']);
    expect(scope.addedLater.map((x) => x.title)).toEqual(['未评估的紧急需求']);
  });
});

describe('加入迭代的目标限制', () => {
  it('已完成或已取消的迭代不能加入；其他产品的常规迭代不能加入；专项可以接收不同产品的需求', async () => {
    await expect(setRequirementIteration(t.db, owner, r.id, { iterationId: finished.id })).rejects.toMatchObject({
      code: 'invalid',
      message: '只能加入规划中或进行中的迭代',
    });
    await expect(setRequirementIteration(t.db, owner, r.id, { iterationId: canceled.id })).rejects.toMatchObject({
      code: 'invalid',
      message: '只能加入规划中或进行中的迭代',
    });
    await expect(setRequirementIteration(t.db, owner, r.id, { iterationId: docIteration.id })).rejects.toMatchObject({
      code: 'invalid',
      message: '不能加入其他产品的迭代',
    });
    await expect(setRequirementIteration(t.db, owner, r.id, { iterationId: '00000000-0000-0000-0000-000000000000' })).rejects.toMatchObject({
      code: 'not_found',
    });
    expect((await setRequirementIteration(t.db, owner, r.id, { iterationId: special.id })).iteration?.id).toBe(special.id);
    const docReq = await createRequirement(t.db, owner, doc, { title: '文档协作' });
    await setRequirementIteration(t.db, owner, docReq.id, { iterationId: special.id });
    expect((await getIteration(t.db, owner, special.id)).requirements.map((x) => x.title).sort()).toEqual(['分享链接有效期', '文档协作'].sort());
    expect((await iterationEvents(r.id)).at(-1)!.payload).toMatchObject({ changes: [{ field: 'iterationId', old: planning.id, new: special.id }] });
  });

  it('移出迭代总是允许，重复移出没有变化', async () => {
    const before = (await iterationEvents(r.id)).length;
    expect(await setRequirementIteration(t.db, editor, r.id, { iterationId: null })).toEqual({ iteration: null });
    expect(await setRequirementIteration(t.db, editor, r.id, { iterationId: null })).toEqual({ iteration: null });
    const events = await iterationEvents(r.id);
    expect(events).toHaveLength(before + 1);
    expect(events.at(-1)!.payload).toMatchObject({ changes: [{ field: 'iterationId', old: special.id, new: null }], forced: false });
  });
});
