import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccountView } from '../src/auth/accounts';
import { iterations, requirements } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import type { Actor } from '../src/domain-types';
import { createIteration, setIterationStatus } from '../src/iterations/iterations';
import { setRequirementIteration } from '../src/iterations/membership';
import { nowIterationToday } from '../src/iterations/now-iterations';
import { createBlocker, resolveBlocker } from '../src/requirements/blockers';
import { createRequirement } from '../src/requirements/requirements';
import { getIterationGantt } from '../src/tasks/queries';
import { todayInZone } from '../src/tasks/schedule';
import { createTask, updateTask } from '../src/tasks/tasks';
import { acceptInvitation, createInvitation } from '../src/tenancy/invitations';
import { createOrganization, resolveActor, updateOrganization } from '../src/tenancy/orgs';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { getWorkbench } from '../src/workbench/workbench';
import { createTestDb } from './db';
import { asMember, regularIteration, seedInstance } from './factories';

const DAY = '2026-10-23';

/** 上海墙钟。上海无夏令时，UTC+8。 */
function atShanghai(date: string, hour: number, minute: number): Date {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!, hour - 8, minute));
}

const NOON = atShanghai(DAY, 12, 0);

let t: Awaited<ReturnType<typeof createTestDb>>;
let account: AccountView;
let owner: Actor;
let guestAccountId: string;
let blindAccountId: string;

beforeAll(async () => {
  t = await createTestDb();
  ({ account, owner } = await seedInstance(t.db));
  const peer = await asMember(t.db, owner, '同事戊');

  const product = async (key: string, name: string) => (await createProduct(t.db, owner, { name, key })).id;
  const aaa = await product('AAA', '甲产品');
  const bnd = await product('BND', '边界');
  const hid = await product('HID', '隐产品');
  const hol = await product('HOL', '空心产品');
  const hzp = await product('HZP', '零进度');
  const sam = await product('SAM', '同产品');
  const zzz = await product('ZZZ', '乙产品');
  const pln = await product('PLN', '规划产品');
  const don = await product('DON', '完成产品');
  const can = await product('CAN', '取消产品');
  const del = await product('DEL', '删除产品');

  const sprint = await createIteration(t.db, owner, {
    ...regularIteration(aaa, '进行中含今天', '2026-10-20', '2026-10-30'),
    milestones: [
      { label: '提测', date: '2026-10-22' },
      { label: '发布', date: '2026-10-28' },
    ],
  });
  const openReq = await createRequirement(t.db, owner, aaa, { title: '上传提速', ownerMemberId: owner.memberId });
  const doneReq = await createRequirement(t.db, owner, aaa, { title: '已完成需求', ownerMemberId: owner.memberId });
  await withOrg(t.db, owner.orgId, (tx) => tx.update(requirements).set({ stateKey: 'done' }).where(eq(requirements.id, doneReq.id)));
  await setRequirementIteration(t.db, owner, openReq.id, { iterationId: sprint.id });
  await setRequirementIteration(t.db, owner, doneReq.id, { iterationId: sprint.id });
  await createBlocker(t.db, owner, openReq.id, { description: '等接口' });
  await createBlocker(t.db, owner, openReq.id, { description: '等设计' });
  const solved = await createBlocker(t.db, owner, openReq.id, { description: '已经解开' });
  await resolveBlocker(t.db, owner, solved.id);
  await createTask(t.db, owner, {
    iterationId: sprint.id,
    requirementId: openReq.id,
    title: '接口联调',
    assigneeMemberId: owner.memberId,
    planStart: '2026-10-20',
    planDays: 4,
  });
  const finished = await createTask(t.db, owner, { iterationId: sprint.id, title: '已完成任务', assigneeMemberId: owner.memberId });
  await updateTask(t.db, owner, finished.id, { status: 'done' });
  await createTask(t.db, owner, { iterationId: sprint.id, title: '同事任务', assigneeMemberId: peer.memberId });
  const attention = await createTask(t.db, owner, { iterationId: sprint.id, title: '需要关注', assigneeMemberId: owner.memberId });
  await updateTask(t.db, owner, attention.id, { flag: 'attention', note: '注意接口' });
  await setIterationStatus(t.db, owner, sprint.id, 'active');

  await setIterationStatus(t.db, owner, (await createIteration(t.db, owner, regularIteration(aaa, '尚未开始', '2026-12-01', '2026-12-10'))).id, 'active');
  await setIterationStatus(t.db, owner, (await createIteration(t.db, owner, regularIteration(aaa, '早已结束', '2026-07-01', '2026-07-10'))).id, 'active');
  await createIteration(t.db, owner, regularIteration(pln, '只是规划', '2026-10-01', '2026-10-31'));
  const doneIter = await createIteration(t.db, owner, regularIteration(don, '已经做完', '2026-10-01', '2026-10-31'));
  await setIterationStatus(t.db, owner, doneIter.id, 'active');
  await setIterationStatus(t.db, owner, doneIter.id, 'done');
  await setIterationStatus(t.db, owner, (await createIteration(t.db, owner, regularIteration(can, '已经取消', '2026-10-01', '2026-10-31'))).id, 'canceled');
  const dropped = await createIteration(t.db, owner, regularIteration(del, '已删除的迭代', '2026-10-01', '2026-10-31'));
  await setIterationStatus(t.db, owner, dropped.id, 'active');
  await withOrg(t.db, owner.orgId, (tx) => tx.update(iterations).set({ deletedAt: new Date() }).where(eq(iterations.id, dropped.id)));

  await setIterationStatus(t.db, owner, (await createIteration(t.db, owner, regularIteration(bnd, '边界日', DAY, DAY))).id, 'active');
  await setIterationStatus(t.db, owner, (await createIteration(t.db, owner, regularIteration(hol, '空心', '2026-10-01', '2026-10-31'))).id, 'active');
  const zero = await createIteration(t.db, owner, regularIteration(hzp, '零进度', DAY, DAY));
  await setIterationStatus(t.db, owner, zero.id, 'active');
  const unscheduled = await createTask(t.db, owner, { iterationId: zero.id, title: '未排期任务', assigneeMemberId: owner.memberId });
  await updateTask(t.db, owner, unscheduled.id, { note: '还没排期' });

  await setIterationStatus(t.db, owner, (await createIteration(t.db, owner, regularIteration(sam, '前段', '2026-10-01', DAY))).id, 'active');
  await setIterationStatus(t.db, owner, (await createIteration(t.db, owner, regularIteration(sam, '后段', DAY, '2026-10-30'))).id, 'active');

  const zee = await createIteration(t.db, owner, regularIteration(zzz, '乙产品此刻', '2026-10-01', '2026-10-31'));
  await setIterationStatus(t.db, owner, zee.id, 'active');
  for (let i = 1; i <= 6; i++) {
    const task = await createTask(t.db, owner, { iterationId: zee.id, title: `周知${i}`, assigneeMemberId: owner.memberId });
    await updateTask(t.db, owner, task.id, { note: `说明${i}` });
  }

  const hidden = await createIteration(t.db, owner, regularIteration(hid, '机密迭代', '2026-10-01', '2026-10-31'));
  await setIterationStatus(t.db, owner, hidden.id, 'active');
  const hiddenReq = await createRequirement(t.db, owner, hid, { title: '机密需求', ownerMemberId: owner.memberId });
  await setRequirementIteration(t.db, owner, hiddenReq.id, { iterationId: hidden.id });
  await createBlocker(t.db, owner, hiddenReq.id, { description: '机密阻塞' });
  const hiddenTask = await createTask(t.db, owner, { iterationId: hidden.id, title: '机密任务', assigneeMemberId: owner.memberId });
  await updateTask(t.db, owner, hiddenTask.id, { note: '机密说明' });

  const special = await createIteration(t.db, owner, { type: 'special', name: '专项冲刺', startDate: '2026-10-15', endDate: '2026-10-25' });
  await setIterationStatus(t.db, owner, special.id, 'active');
  const visibleReq = await createRequirement(t.db, owner, aaa, { title: '专项可见需求', ownerMemberId: owner.memberId });
  const secretReq = await createRequirement(t.db, owner, hid, { title: '专项机密需求', ownerMemberId: owner.memberId });
  await setRequirementIteration(t.db, owner, visibleReq.id, { iterationId: special.id });
  await setRequirementIteration(t.db, owner, secretReq.id, { iterationId: special.id });
  await createBlocker(t.db, owner, visibleReq.id, { description: '等可见' });
  await createBlocker(t.db, owner, secretReq.id, { description: '等机密' });
  await createTask(t.db, owner, { iterationId: special.id, productId: aaa, title: '专项可见任务', assigneeMemberId: owner.memberId });
  const secretTask = await createTask(t.db, owner, { iterationId: special.id, productId: hid, title: '专项机密任务', assigneeMemberId: owner.memberId });
  await updateTask(t.db, owner, secretTask.id, { note: '专项机密说明' });

  const invite = async (email: string) => {
    const { token } = await createInvitation(t.db, owner, { email, orgRole: 'guest' });
    return (await acceptInvitation(t.db, token, { newAccount: { name: email, password: 'password123' } })).accountId;
  };
  guestAccountId = await invite('guest-view@example.com');
  const guest = (await resolveActor(t.db, guestAccountId, 'acme'))!;
  await setProductRole(t.db, owner, aaa, guest.memberId, 'viewer');
  blindAccountId = await invite('guest-blind@example.com');

  const { org: other } = await createOrganization(t.db, account, { name: '第二组织', slug: 'other' });
  const otherActor = (await resolveActor(t.db, account.id, 'other'))!;
  const doc = (await createProduct(t.db, otherActor, { name: '文档', key: 'DOC' })).id;
  const otherIter = await createIteration(t.db, otherActor, regularIteration(doc, '他组织此刻', '2026-10-01', '2026-10-31'));
  await setIterationStatus(t.db, otherActor, otherIter.id, 'active');
  await createRequirement(t.db, otherActor, doc, { title: '另一个组织的需求', ownerMemberId: otherActor.memberId });
  void other;

  const bareActor = (await resolveActor(t.db, account.id, (await createOrganization(t.db, account, { name: '空组织', slug: 'bare' })).org.slug))!;
  await createProduct(t.db, bareActor, { name: '空产品', key: 'EMP' });

  const sideActor = (await resolveActor(t.db, account.id, (await createOrganization(t.db, account, { name: '旁路组织', slug: 'side' })).org.slug))!;
  const sidePlan = (await createProduct(t.db, sideActor, { name: '旁路规划', key: 'SDP' })).id;
  const sideDone = (await createProduct(t.db, sideActor, { name: '旁路完成', key: 'SDD' })).id;
  await createIteration(t.db, sideActor, regularIteration(sidePlan, '即将开始', '2026-10-20', '2026-10-30'));
  const sideFinished = await createIteration(t.db, sideActor, regularIteration(sideDone, '旁路已完成', '2026-10-01', '2026-10-31'));
  await setIterationStatus(t.db, sideActor, sideFinished.id, 'active');
  await setIterationStatus(t.db, sideActor, sideFinished.id, 'done');
});
afterAll(() => t.cleanup());

const namesOf = async (accountId: string, orgSlug: string, now: Date = NOON) =>
  (await getWorkbench(t.db, accountId, { orgSlug, now })).nowIterations.map((i) => i.name);

describe('此刻迭代', () => {
  it('上海自然日：当天 00:00 与 23:59 都算今天，跨零点分属前后两天，不用 UTC', () => {
    expect(nowIterationToday(atShanghai(DAY, 0, 0))).toBe(DAY);
    expect(nowIterationToday(atShanghai(DAY, 23, 59))).toBe(DAY);
    expect(nowIterationToday(atShanghai('2026-10-22', 23, 59))).toBe('2026-10-22');
    expect(nowIterationToday(atShanghai('2026-10-24', 0, 0))).toBe('2026-10-24');
    expect(todayInZone('UTC', atShanghai(DAY, 0, 0))).toBe('2026-10-22');
    expect(todayInZone('UTC', atShanghai('2026-10-24', 0, 0))).toBe(DAY);
  });

  it('选中 active 且闭区间含今天；不选 planning、done、canceled、已删除、日期在窗外的', async () => {
    expect(await namesOf(account.id, 'acme')).toEqual(['进行中含今天', '边界日', '机密迭代', '空心', '零进度', '后段', '前段', '乙产品此刻', '专项冲刺']);
    const absent = ['尚未开始', '早已结束', '只是规划', '已经做完', '已经取消', '已删除的迭代', '他组织此刻', '即将开始', '旁路已完成'];
    const names = await namesOf(account.id, 'acme');
    for (const name of absent) expect(names).not.toContain(name);
  });

  it('起止当天都算入；上海 00:00 算入，23:59 算入，前一天 23:59 与后一天 00:00 按上海日切开', async () => {
    expect(await namesOf(account.id, 'acme', atShanghai(DAY, 0, 0))).toEqual(expect.arrayContaining(['边界日', '前段', '后段']));
    expect(await namesOf(account.id, 'acme', atShanghai(DAY, 23, 59))).toEqual(expect.arrayContaining(['边界日', '前段', '后段']));

    const prev = await namesOf(account.id, 'acme', atShanghai('2026-10-22', 23, 59));
    expect(prev).toContain('进行中含今天');
    expect(prev).toContain('前段');
    expect(prev).not.toContain('边界日');
    expect(prev).not.toContain('后段');

    const next = await namesOf(account.id, 'acme', atShanghai('2026-10-24', 0, 0));
    expect(next).toContain('进行中含今天');
    expect(next).toContain('后段');
    expect(next).not.toContain('边界日');
    expect(next).not.toContain('前段');
  });

  it('组织时区改成 UTC 后，选择仍按上海自然日，不用六块的 today 参数', async () => {
    await updateOrganization(t.db, owner, { timezone: 'UTC' });
    try {
      const atMidnight = await getWorkbench(t.db, account.id, { orgSlug: 'acme', now: atShanghai(DAY, 0, 0), today: '1999-01-01' });
      expect(atMidnight.nowIterations.map((i) => i.name)).toEqual(expect.arrayContaining(['边界日', '后段']));
    } finally {
      await updateOrganization(t.db, owner, { timezone: 'Asia/Shanghai' });
    }
  });

  it('无 org 时空数组且不报错，六块仍跨组织；带 org 只含该组织', async () => {
    const plain = await getWorkbench(t.db, account.id, { now: NOON });
    expect(plain.nowIterations).toEqual([]);
    expect(plain.nowIterationPresence).toBe('unscoped');
    expect(plain.planningHint).toBeNull();
    expect(plain.owned.items.some((r) => r.org.slug === 'other')).toBe(true);

    const blank = await getWorkbench(t.db, account.id, { orgSlug: '  ', now: NOON });
    expect(blank.nowIterations).toEqual([]);
    expect(blank.nowIterationPresence).toBe('unscoped');

    const acme = await getWorkbench(t.db, account.id, { orgSlug: 'acme', now: NOON });
    expect(acme.nowIterations.some((i) => i.name === '他组织此刻')).toBe(false);
    expect(acme.owned.items.some((r) => r.org.slug === 'other')).toBe(true);

    const other = await getWorkbench(t.db, account.id, { orgSlug: 'other', now: NOON });
    expect(other.nowIterations.map((i) => i.name)).toEqual(['他组织此刻']);
    expect(other.nowIterationPresence).toBe('present');
  });

  it('组织不存在、或不是成员时为空数组', async () => {
    const missing = await getWorkbench(t.db, account.id, { orgSlug: 'missing', now: NOON });
    expect(missing.nowIterations).toEqual([]);
    expect(missing.nowIterationPresence).toBe('none');
    const outsider = await getWorkbench(t.db, guestAccountId, { orgSlug: 'other', now: NOON });
    expect(outsider.nowIterations).toEqual([]);
    expect(outsider.nowIterationPresence).toBe('none');
  });

  it('没有可见迭代、以及有迭代但没有此刻时，空态与规划次要链分开', async () => {
    const bare = await getWorkbench(t.db, account.id, { orgSlug: 'bare', now: NOON });
    expect(bare.nowIterations).toEqual([]);
    expect(bare.nowIterationPresence).toBe('none');
    expect(bare.planningHint).toBeNull();

    const side = await getWorkbench(t.db, account.id, { orgSlug: 'side', now: NOON });
    expect(side.nowIterations).toEqual([]);
    expect(side.nowIterationPresence).toBe('no_now');
    expect(side.planningHint).toMatchObject({ name: '即将开始', product: { key: 'SDP' } });
  });

  it('不可见产品的迭代、计数和概览都不出现；没有任何可见产品时专项也不出', async () => {
    const guest = await getWorkbench(t.db, guestAccountId, { orgSlug: 'acme', now: NOON });
    expect(guest.nowIterations.map((i) => i.name)).toEqual(['进行中含今天', '专项冲刺']);
    const dumped = JSON.stringify({ nowIterations: guest.nowIterations, planningHint: guest.planningHint });
    for (const secret of ['机密迭代', '机密需求', '机密任务', '机密说明', '机密阻塞', '乙产品此刻', '专项机密', '等机密']) {
      expect(dumped).not.toContain(secret);
    }
    const special = guest.nowIterations.find((i) => i.name === '专项冲刺')!;
    expect(special.requirementCount).toBe(1);
    expect(special.blockerCount).toBe(1);
    expect(special.myTaskCount).toBe(0);
    expect(special.overview!.taskCount).toBe(1);
    expect(special.myTasks).toEqual([]);

    const ownerWb = await getWorkbench(t.db, account.id, { orgSlug: 'acme', now: NOON });
    const ownerSpecial = ownerWb.nowIterations.find((i) => i.name === '专项冲刺')!;
    expect(ownerSpecial.requirementCount).toBe(2);
    expect(ownerSpecial.blockerCount).toBe(2);
    expect(ownerSpecial.myTaskCount).toBe(2);
    expect(ownerSpecial.overview!.taskCount).toBe(2);

    const blind = await getWorkbench(t.db, blindAccountId, { orgSlug: 'acme', now: NOON });
    expect(blind.nowIterations).toEqual([]);
    expect(blind.nowIterationPresence).toBe('none');
    expect(blind.planningHint).toBeNull();
    expect(JSON.stringify(blind.nowIterations)).not.toContain('专项冲刺');
  });

  it('概览与甘特同一口径；我的未完成任务和 active 阻塞按本迭代合计；空心与关注截断', async () => {
    const wb = await getWorkbench(t.db, account.id, { orgSlug: 'acme', now: NOON });
    const card = wb.nowIterations.find((i) => i.name === '进行中含今天')!;
    const gantt = await getIterationGantt(t.db, owner, card.id, { today: DAY });
    expect(card.status).toBe('active');
    expect(card.product).toMatchObject({ key: 'AAA', name: '甲产品' });
    expect(card.baselineEndDate).toBe('2026-10-30');
    expect(card.requirementCount).toBe(2);
    expect(card.doneCount).toBe(1);
    expect(card.blockerCount).toBe(2);
    expect(card.myTaskCount).toBe(2);
    expect(card.myTasks.map((task) => task.title)).toEqual(['接口联调', '需要关注']);
    expect(card.myTasks[0]).toMatchObject({ requirement: { displayKey: 'AAA-1', title: '上传提速' } });
    expect(card.myTasks[1]!.requirement).toBeNull();
    expect(card.milestoneSummary).toEqual({
      total: 2,
      past: 1,
      upcoming: 1,
      next: { label: '发布', date: '2026-10-28' },
    });
    expect(card.overview).toMatchObject({
      overall: gantt.overview.overall,
      expected: gantt.overview.expected,
      behind: gantt.overview.behind,
      deferred: gantt.overview.deferred,
      rowCount: gantt.overview.rowCount,
      countedCount: gantt.overview.countedCount,
      taskCount: gantt.tasks.length,
      isHollow: false,
      attentionTruncated: false,
    });
    expect(card.overview!.attention).toEqual(gantt.overview.attention);
    expect(card.overview!.overall).toBeGreaterThan(0);

    const hollow = wb.nowIterations.find((i) => i.name === '空心')!;
    expect(hollow.overview).toMatchObject({ isHollow: true, taskCount: 0, overall: 0, attention: [] });
    const zero = wb.nowIterations.find((i) => i.name === '零进度')!;
    expect(zero.overview).toMatchObject({ isHollow: true, taskCount: 1, overall: 0, expected: 0, behind: 0, deferred: 0 });
    expect(zero.overview!.attention).toEqual([expect.objectContaining({ kind: 'notice', title: '未排期任务', note: '还没排期' })]);

    const notices = wb.nowIterations.find((i) => i.name === '乙产品此刻')!;
    expect(notices.myTaskCount).toBe(6);
    expect(notices.myTasks).toHaveLength(5);
    expect(notices.overview!.attention).toHaveLength(5);
    expect(notices.overview!.attentionTruncated).toBe(true);
  });
});
