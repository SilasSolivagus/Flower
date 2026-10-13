import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadIterationFacts, loadIterationOptions, loadReleaseFacts, loadSpecialFacts } from '../src/dashboard/delivery';
import { loadProductFlow } from '../src/dashboard/flow';
import { iterations, requirements } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import type { Actor } from '../src/domain-types';
import { createIteration, setIterationStatus } from '../src/iterations/iterations';
import { setRequirementIteration } from '../src/iterations/membership';
import { createRelease } from '../src/releases/releases';
import { createRequirement } from '../src/requirements/requirements';
import { createProduct } from '../src/tenancy/products';
import { createTestDb } from './db';
import { regularIteration, seedInstance } from './factories';

const SH = 'Asia/Shanghai';
let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let pan: string;
let r1: string;
let r2: string;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  const doc = (await createProduct(t.db, owner, { name: '文档', key: 'DOC' })).id;
  r1 = (await createRequirement(t.db, owner, pan, { title: '需求一' })).id;
  r2 = (await createRequirement(t.db, owner, pan, { title: '需求二' })).id;
  const r3 = (await createRequirement(t.db, owner, pan, { title: '专项里的需求' })).id;
  const x = (await createRequirement(t.db, owner, doc, { title: '文档需求甲' })).id;
  const y = (await createRequirement(t.db, owner, doc, { title: '文档需求乙' })).id;

  // 第 0 轮：开始时为空，没有承诺范围快照
  const it0 = (await createIteration(t.db, owner, regularIteration(pan, '第 0 轮', '2026-08-01', '2026-08-20'))).id;
  await setIterationStatus(t.db, owner, it0, 'active');
  await setIterationStatus(t.db, owner, it0, 'done');
  // 第 1 轮：r1、r2 在开始前加入（进入快照），结束后 r2 被移出
  const it1 = (await createIteration(t.db, owner, regularIteration(pan, '第 1 轮', '2026-09-01', '2026-09-30'))).id;
  await setRequirementIteration(t.db, owner, r1, { iterationId: it1 });
  await setRequirementIteration(t.db, owner, r2, { iterationId: it1 });
  await setIterationStatus(t.db, owner, it1, 'active');
  await setIterationStatus(t.db, owner, it1, 'done');
  await setRequirementIteration(t.db, owner, r2, { iterationId: null });
  // 第 2 轮：规划中（已到开始日）；已取消的一轮；别的产品的一轮
  await createIteration(t.db, owner, regularIteration(pan, '第 2 轮', '2026-10-01', '2026-10-20'));
  const canceled = (await createIteration(t.db, owner, regularIteration(pan, '已取消', '2026-06-01', '2026-06-10'))).id;
  await setIterationStatus(t.db, owner, canceled, 'canceled');
  const docIt = (await createIteration(t.db, owner, regularIteration(doc, '文档 1 轮', '2026-09-01', '2026-09-30'))).id;
  await setIterationStatus(t.db, owner, docIt, 'active');
  // 专项甲含 PAN 的 r3 与 DOC 的 x；专项乙只含 DOC 的 y
  const sp = (await createIteration(t.db, owner, { type: 'special', name: '专项甲', startDate: '2026-09-01', endDate: '2026-12-31' })).id;
  await setRequirementIteration(t.db, owner, r3, { iterationId: sp });
  await setRequirementIteration(t.db, owner, x, { iterationId: sp });
  const sp2 = (await createIteration(t.db, owner, { type: 'special', name: '专项乙', startDate: '2026-09-01', endDate: '2026-12-31' })).id;
  await setRequirementIteration(t.db, owner, y, { iterationId: sp2 });

  // 版本：v1 不属于迭代；v2 属于第 1 轮；v3 属于一个之后被删除的迭代
  await createRelease(t.db, owner, { productId: pan, versionName: 'v1', plannedDate: '2026-09-25' });
  await createRelease(t.db, owner, { productId: pan, versionName: 'v2', iterationId: it1, plannedDate: '2026-09-30' });
  const temp = (await createIteration(t.db, owner, regularIteration(pan, '临时', '2026-07-01', '2026-07-10'))).id;
  await createRelease(t.db, owner, { productId: pan, versionName: 'v3', iterationId: temp, plannedDate: '2026-07-10' });
  await t.adminDb.update(iterations).set({ deletedAt: new Date() }).where(eq(iterations.id, temp));
});
afterAll(() => t.cleanup());

describe('读取版本、迭代与专项', () => {
  it('版本：带出所属迭代的结束日；迭代已删除或没有迭代时为空', async () => {
    const facts = await withOrg(t.db, owner.orgId, (tx) => loadReleaseFacts(tx, pan));
    expect(facts.map((f) => [f.versionName, f.status, f.plannedDate, f.baselineDate, f.releasedAt, f.iterationEndDate]).sort()).toEqual([
      ['v1', 'planned', '2026-09-25', '2026-09-25', null, null],
      ['v2', 'planned', '2026-09-30', '2026-09-30', null, '2026-09-30'],
      ['v3', 'planned', '2026-07-10', '2026-07-10', null, null],
    ]);
  });

  it('迭代：只取本产品与时间段有交集、已开始（进行中或已完成）的常规迭代，带承诺范围与当前范围', async () => {
    const facts = await withOrg(t.db, owner.orgId, async (tx) => loadIterationFacts(tx, pan, await loadProductFlow(tx, pan, SH), '2026-07-16', '2026-10-13'));
    expect(facts.map((f) => ({ name: f.name, status: f.status, taken: f.snapshotTaken, committed: [...f.committedIds].sort(), current: f.currentIds }))).toEqual([
      { name: '第 1 轮', status: 'done', taken: true, committed: [r1, r2].sort(), current: [r1] },
      { name: '第 0 轮', status: 'done', taken: false, committed: [], current: [] },
    ]);
  });

  it('专项：只取含本产品需求的专项，只带本产品需求的状态', async () => {
    const facts = await withOrg(t.db, owner.orgId, async (tx) => loadSpecialFacts(tx, await loadProductFlow(tx, pan, SH), '2026-07-16', '2026-10-13'));
    expect(facts.map((s) => [s.name, s.status, s.stateKeys])).toEqual([['专项甲', 'planning', ['backlog']]]);
  });

  it('可选迭代：本产品已到开始日、未取消、未删除的常规迭代，开始日倒序', async () => {
    const options = await withOrg(t.db, owner.orgId, (tx) => loadIterationOptions(tx, pan, '2026-10-13'));
    expect(options.map((o) => [o.name, o.status])).toEqual([
      ['第 2 轮', 'planning'],
      ['第 1 轮', 'done'],
      ['第 0 轮', 'done'],
    ]);
  });

  it('承诺范围里的需求之后全部被删除：快照仍算取过，当前范围为空', async () => {
    const zzz = (await createProduct(t.db, owner, { name: '归档', key: 'ZZZ' })).id;
    const a = (await createRequirement(t.db, owner, zzz, { title: '将被删除' })).id;
    const it = (await createIteration(t.db, owner, regularIteration(zzz, '删光', '2026-09-01', '2026-09-30'))).id;
    await setRequirementIteration(t.db, owner, a, { iterationId: it });
    await setIterationStatus(t.db, owner, it, 'active');
    await t.adminDb.update(requirements).set({ deletedAt: new Date() }).where(eq(requirements.id, a));
    const facts = await withOrg(t.db, owner.orgId, async (tx) => loadIterationFacts(tx, zzz, await loadProductFlow(tx, zzz, SH), '2026-09-01', '2026-10-13'));
    expect(facts.map((f) => ({ name: f.name, taken: f.snapshotTaken, committed: f.committedIds, current: f.currentIds }))).toEqual([
      { name: '删光', taken: true, committed: [a], current: [] },
    ]);
  });
});
