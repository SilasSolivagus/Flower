import { and, asc, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { domainEvents, requirements } from '../src/db/schema';
import type { Actor } from '../src/domain-types';
import { getRequirementByKey } from '../src/requirements/detail';
import { createRequirement } from '../src/requirements/requirements';
import { transitionRequirement } from '../src/requirements/transitions';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { joinTracking, leaveTracking, pauseRequirement, resumeRequirement, setRequirementExpectedDate } from '../src/tracking/requirement-tracking';
import { createTestDb } from './db';
import { applyTrackingWorkflow, asMember, readOnlyToken, seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let viewer: Actor;
let pan: string;
let quick: string;

const create = (title: string, productId = pan) => createRequirement(t.db, owner, productId, { title });
const move = (id: string, to: string) => transitionRequirement(t.db, owner, id, { to });
const row = async (id: string) => (await t.adminDb.select().from(requirements).where(eq(requirements.id, id)))[0]!;
const events = (id: string, types: string[]) =>
  t.adminDb
    .select()
    .from(domainEvents)
    .where(and(eq(domainEvents.subjectId, id), inArray(domainEvents.type, types)))
    .orderBy(asc(domainEvents.occurredAt), asc(domainEvents.id));

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  quick = (await createProduct(t.db, owner, { name: '快传', key: 'QK' })).id;
  await applyTrackingWorkflow(t.db, owner, pan);
  await applyTrackingWorkflow(t.db, owner, quick, 'design');
  viewer = await asMember(t.db, owner, '只读成员');
  await setProductRole(t.db, owner, pan, viewer.memberId, 'viewer');
});
afterAll(() => t.cleanup());

describe('自动加入跟进', () => {
  it('第一次进入未开始或进行中类别时加入；收集阶段不加入；之后在这两类之间流转不重复加入', async () => {
    const r = await create('自动加入');
    expect((await row(r.id)).trackedSince).toBeNull();
    await move(r.id, 'design');
    const first = (await row(r.id)).trackedSince;
    expect(first).not.toBeNull();
    await move(r.id, 'dev');
    expect((await row(r.id)).trackedSince).toEqual(first);
    const joined = await events(r.id, ['requirement.tracking_joined']);
    expect(joined).toHaveLength(1);
    expect(joined[0]!.payload).toMatchObject({ auto: true });
  });

  it('初始状态属于未开始类别时，新建即加入跟进', async () => {
    const r = await create('直接进入设计', quick);
    expect((await row(r.id)).trackedSince).not.toBeNull();
    expect(await events(r.id, ['requirement.tracking_joined'])).toHaveLength(1);
  });

  it('重新打开或退回收集：加入时间保留，不重复记加入事件，仍算跟进中', async () => {
    const r = await create('重新打开');
    await move(r.id, 'dev');
    const since = (await row(r.id)).trackedSince;
    await move(r.id, 'done');
    let d = await getRequirementByKey(t.db, owner, r.displayKey);
    expect(d.tracking.active).toBe(false);
    expect(d.tracking.trackedSince).toEqual(since);
    await move(r.id, 'dev');
    d = await getRequirementByKey(t.db, owner, r.displayKey);
    expect(d.tracking.active).toBe(true);
    await move(r.id, 'backlog');
    d = await getRequirementByKey(t.db, owner, r.displayKey);
    expect(d.tracking.active).toBe(true);
    expect(d.tracking.trackedSince).toEqual(since);
    expect(await events(r.id, ['requirement.tracking_joined'])).toHaveLength(1);
  });
});

describe('手动加入与移出', () => {
  it('手动移出后不再自动加入；手动加入（含收集阶段）清掉移出标记；重复加入、未加入时移出报错', async () => {
    const r = await create('手动');
    await expect(leaveTracking(t.db, owner, r.id)).rejects.toMatchObject({ code: 'invalid', message: '需求不在跟进中' });
    expect(await joinTracking(t.db, owner, r.id)).toMatchObject({ active: true, optedOut: false });
    await expect(joinTracking(t.db, owner, r.id)).rejects.toMatchObject({ code: 'invalid', message: '需求已在跟进中' });
    expect(await leaveTracking(t.db, owner, r.id)).toMatchObject({ trackedSince: null, active: false, optedOut: true });
    await move(r.id, 'dev');
    expect((await row(r.id)).trackedSince).toBeNull();
    expect(await joinTracking(t.db, owner, r.id)).toMatchObject({ active: true, optedOut: false });
    const list = await events(r.id, ['requirement.tracking_joined', 'requirement.tracking_left']);
    expect(list.map((e) => [e.type, (e.payload as { auto?: boolean }).auto ?? null])).toEqual([
      ['requirement.tracking_joined', false],
      ['requirement.tracking_left', null],
      ['requirement.tracking_joined', false],
    ]);
  });

  it('已上线或已取消的需求不能加入', async () => {
    const r = await create('已上线');
    await move(r.id, 'done');
    await expect(joinTracking(t.db, owner, r.id)).rejects.toMatchObject({ code: 'invalid', message: '已上线或已取消的需求不能加入跟进' });
  });
});

describe('暂停与预计上线日期', () => {
  it('暂停与恢复：原因必填；重复暂停、没有暂停时恢复报错且不写事件；改状态不自动恢复', async () => {
    const r = await create('暂停');
    await expect(pauseRequirement(t.db, owner, r.id, { reason: '等设计' })).rejects.toMatchObject({ code: 'invalid', message: '只有跟进中的需求可以暂停' });
    await move(r.id, 'design');
    for (const reason of ['  ', 'x'.repeat(201)]) {
      await expect(pauseRequirement(t.db, owner, r.id, { reason })).rejects.toMatchObject({ code: 'invalid', message: '暂停原因不能为空，且不超过 200 个字符' });
    }
    await expect(resumeRequirement(t.db, owner, r.id)).rejects.toMatchObject({ code: 'invalid', message: '需求没有暂停' });
    expect((await pauseRequirement(t.db, owner, r.id, { reason: ' 等法务确认 ' })).paused).toMatchObject({ reason: '等法务确认' });
    await expect(pauseRequirement(t.db, owner, r.id, { reason: '再暂停' })).rejects.toMatchObject({ code: 'invalid', message: '需求已暂停' });
    await move(r.id, 'dev');
    expect((await row(r.id)).pausedAt).not.toBeNull();
    expect((await resumeRequirement(t.db, owner, r.id)).paused).toBeNull();
    await expect(resumeRequirement(t.db, owner, r.id)).rejects.toMatchObject({ code: 'invalid', message: '需求没有暂停' });
    const list = await events(r.id, ['requirement.paused', 'requirement.resumed']);
    expect(list.map((e) => e.type)).toEqual(['requirement.paused', 'requirement.resumed']);
    expect(list[0]!.payload).toMatchObject({ reason: '等法务确认' });
  });

  it('预计上线日期：校验格式；与原值相同时不记事件', async () => {
    const r = await create('预计日期');
    await expect(setRequirementExpectedDate(t.db, owner, r.id, '2026-02-30')).rejects.toMatchObject({ code: 'invalid', message: '预计上线日期格式应为 YYYY-MM-DD' });
    expect(await setRequirementExpectedDate(t.db, owner, r.id, '2026-11-20')).toMatchObject({ expectedDate: '2026-11-20' });
    await setRequirementExpectedDate(t.db, owner, r.id, '2026-11-20');
    expect(await setRequirementExpectedDate(t.db, owner, r.id, null)).toMatchObject({ expectedDate: null });
    expect((await events(r.id, ['requirement.expected_date_changed'])).map((e) => (e.payload as { changes: unknown[] }).changes)).toEqual([
      [{ field: 'expectedDate', old: null, new: '2026-11-20' }],
      [{ field: 'expectedDate', old: '2026-11-20', new: null }],
    ]);
  });

  it('只读成员与只读 Token 不能修改跟进设置；详情里带跟进信息', async () => {
    const r = await create('权限');
    await move(r.id, 'dev');
    for (const a of [viewer, readOnlyToken(owner)]) {
      await expect(pauseRequirement(t.db, a, r.id, { reason: '原因' })).rejects.toMatchObject({ code: 'forbidden' });
      await expect(leaveTracking(t.db, a, r.id)).rejects.toMatchObject({ code: 'forbidden' });
      await expect(setRequirementExpectedDate(t.db, a, r.id, '2026-12-01')).rejects.toMatchObject({ code: 'forbidden' });
    }
    const d = await getRequirementByKey(t.db, viewer, r.displayKey);
    expect(d.tracking).toMatchObject({ active: true, optedOut: false, expectedDate: null, paused: null });
  });
});
