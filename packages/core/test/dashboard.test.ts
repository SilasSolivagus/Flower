import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canViewOrgDashboard, type DashboardRange, getOrgDashboard, getProductDashboard } from '../src/dashboard/dashboard';
import { releases } from '../src/db/schema';
import type { Actor } from '../src/domain-types';
import { createIteration, setIterationStatus } from '../src/iterations/iterations';
import { setRequirementIteration } from '../src/iterations/membership';
import { createRelease, markReleaseReleased } from '../src/releases/releases';
import { createRequirement } from '../src/requirements/requirements';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { rewriteHistory } from './dashboard-helpers';
import { createTestDb } from './db';
import { asMember, readOnlyToken, regularIteration, seedInstance } from './factories';

/** 组织时区 Asia/Shanghai 的 2026-10-13 12:00。 */
const NOW = new Date('2026-10-13T04:00:00Z');
const R90: DashboardRange = { kind: 'days', days: 90 };
const d = (local: string) => `${local}T10:00:00+08:00`;

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let pan: string;
let doc: string;
let empty: string;
let it1: string;
let it2: string;
let docIteration: string;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  doc = (await createProduct(t.db, owner, { name: '文档', key: 'DOC' })).id;
  empty = (await createProduct(t.db, owner, { name: '空产品', key: 'EMP' })).id;
  const ids: string[] = [];
  for (const title of ['已完成一', '已完成二', '进行中', '上期完成', '已取消']) ids.push((await createRequirement(t.db, owner, pan, { title })).id);
  const [a, b, c, prev, canceled] = ids as [string, string, string, string, string];
  const x = (await createRequirement(t.db, owner, doc, { title: '文档需求' })).id;

  // 第 1 轮：a、b 在开始前加入并进入承诺范围，之后结束
  it1 = (await createIteration(t.db, owner, regularIteration(pan, '第 1 轮', '2026-09-01', '2026-09-30'))).id;
  await setRequirementIteration(t.db, owner, a, { iterationId: it1 });
  await setRequirementIteration(t.db, owner, b, { iterationId: it1 });
  await setIterationStatus(t.db, owner, it1, 'active');
  await setIterationStatus(t.db, owner, it1, 'done');
  it2 = (await createIteration(t.db, owner, regularIteration(pan, '第 2 轮', '2026-11-01', '2026-11-30'))).id;
  docIteration = (await createIteration(t.db, owner, regularIteration(doc, '文档 1 轮', '2026-09-01', '2026-09-30'))).id;
  // 专项：PAN 的 c 与 DOC 的 x
  const sp = (await createIteration(t.db, owner, { type: 'special', name: '专项甲', startDate: '2026-09-01', endDate: '2026-12-31' })).id;
  await setRequirementIteration(t.db, owner, c, { iterationId: sp });
  await setRequirementIteration(t.db, owner, x, { iterationId: sp });

  await rewriteHistory(t.adminDb, owner.orgId, a, d('2026-09-01'), [['doing', d('2026-09-10')], ['done', d('2026-09-20')]]);
  await rewriteHistory(t.adminDb, owner.orgId, b, d('2026-09-20'), [['doing', d('2026-09-25')], ['done', d('2026-10-05')]]);
  await rewriteHistory(t.adminDb, owner.orgId, c, d('2026-08-01'), [['doing', d('2026-08-10')]]);
  await rewriteHistory(t.adminDb, owner.orgId, prev, d('2026-06-01'), [['doing', d('2026-06-05')], ['done', d('2026-06-20')]]);
  await rewriteHistory(t.adminDb, owner.orgId, canceled, d('2026-09-01'), [['canceled', d('2026-09-03')]]);
  await rewriteHistory(t.adminDb, owner.orgId, x, d('2026-09-01'), [['done', d('2026-09-02')]]);

  // 版本：v1 按基线日期（09-25）按期；v2 没有基线日期，按第 1 轮结束日（09-30）计，10-02 发布，逾期 2 天
  const v1 = (await createRelease(t.db, owner, { productId: pan, versionName: 'v1', plannedDate: '2026-09-25' })).id;
  const v2 = (await createRelease(t.db, owner, { productId: pan, versionName: 'v2', iterationId: it1, plannedDate: '2026-09-30' })).id;
  await markReleaseReleased(t.db, owner, v1);
  await markReleaseReleased(t.db, owner, v2);
  await t.adminDb.update(releases).set({ releasedAt: new Date('2026-09-24T02:00:00Z') }).where(eq(releases.id, v1));
  await t.adminDb.update(releases).set({ releasedAt: new Date(d('2026-10-02')), baselineDate: null }).where(eq(releases.id, v2));
});
afterAll(() => t.cleanup());

describe('产品看板', () => {
  it('近 90 天：时间段与上期、关键数字、周趋势、卡在哪儿、迭代、版本、专项、评审', async () => {
    const dash = await getProductDashboard(t.db, owner, pan, { range: R90, now: NOW });
    expect(dash.product).toEqual({ id: pan, key: 'PAN', name: '网盘' });
    expect(dash.window).toEqual({
      from: '2026-07-16',
      to: '2026-10-13',
      days: 90,
      previousFrom: '2026-04-17',
      previousTo: '2026-07-15',
      today: '2026-10-13',
      timeZone: 'Asia/Shanghai',
      endsToday: true,
      iteration: null,
    });
    expect(dash.cards).toEqual({
      throughputPerWeek: { value: 0.2, previous: 0.1 },
      leadTimeMedian: { value: 17, previous: 19 },
      flowTimeMedian: { value: 10, previous: 15 },
      wip: { value: 1, previous: 0 },
      releaseOnTimeRate: { value: 0.5, previous: null },
      rejectionRate: { value: null, previous: null },
    });
    expect(dash.completedCount).toBe(2);
    expect(dash.weeks).toHaveLength(14);
    expect(dash.weeks[0]!.week).toBe('2026-07-13');
    expect(dash.weeks.reduce((n, w) => n + w.throughput, 0)).toBe(2);
    expect(dash.weeks.at(-1)).toMatchObject({ week: '2026-10-12', wip: 1 });
    expect(dash.stuck.states).toEqual([{ key: 'doing', label: '进行中', color: '#f59e0b', count: 1, avgDays: 64.1 }]);
    expect(dash.stuck.oldest).toMatchObject([{ displayKey: 'PAN-3', title: '进行中', state: { key: 'doing', label: '进行中' }, days: 64.1 }]);
    expect(dash.iterations).toMatchObject([{ id: it1, name: '第 1 轮', hasSnapshot: true, committed: 2, completed: 1, canceled: 0, rate: 0.5, added: 0, removed: 0 }]);
    expect(dash.releases).toMatchObject({ released: 2, evaluated: 2, onTime: 1, onTimeRate: 0.5 });
    expect(dash.releases.rows.map((r) => [r.versionName, r.dueSource, r.releasedOn, r.onTime, r.overdueDays])).toEqual([
      ['v2', 'iteration', '2026-10-02', false, 2],
      ['v1', 'baseline', '2026-09-24', true, 0],
    ]);
    expect(dash.specials).toMatchObject([{ name: '专项甲', total: 1, completed: 0, canceled: 0, rate: 0 }]);
    expect(dash.review).toEqual({ since: null, concluded: 0, rejected: 0, rejectionRate: null, items: [] });
    expect(dash.iterationOptions.map((o) => o.name)).toEqual(['第 1 轮']);
    expect(JSON.stringify(dash)).not.toContain('文档需求');
  });

  it('按迭代：时间段为迭代的开始日到结束日（不晚于今天），上期为之前同长度的时间段', async () => {
    const dash = await getProductDashboard(t.db, owner, pan, { range: { kind: 'iteration', iterationId: it1 }, now: NOW });
    expect(dash.window).toMatchObject({
      from: '2026-09-01',
      to: '2026-09-30',
      days: 30,
      previousFrom: '2026-08-02',
      previousTo: '2026-08-31',
      endsToday: false,
      iteration: { id: it1, name: '第 1 轮' },
    });
    expect(dash.cards.throughputPerWeek).toEqual({ value: 0.2, previous: 0 });
  });

  it('自定义时间段', async () => {
    const dash = await getProductDashboard(t.db, owner, pan, { range: { kind: 'custom', from: '2026-10-01', to: '2026-10-13' }, now: NOW });
    expect(dash.window).toMatchObject({ from: '2026-10-01', to: '2026-10-13', days: 13, endsToday: true });
    expect(dash.cards.throughputPerWeek.value).toBe(0.5);
  });

  it('时间段参数不合法时给出中文原因', async () => {
    const bad = (range: DashboardRange) => getProductDashboard(t.db, owner, pan, { range, now: NOW });
    await expect(bad({ kind: 'days', days: 45 } as unknown as DashboardRange)).rejects.toMatchObject({ code: 'invalid', message: '时间段只能是近 30、90 或 180 天' });
    await expect(bad({ kind: 'custom', from: '2026-02-30', to: '2026-10-13' })).rejects.toMatchObject({ code: 'invalid', message: '开始日期格式应为 YYYY-MM-DD' });
    await expect(bad({ kind: 'custom', from: '2026-10-05', to: '2026-10-01' })).rejects.toMatchObject({ code: 'invalid', message: '结束日期不能早于开始日期' });
    await expect(bad({ kind: 'custom', from: '2026-10-01', to: '2026-10-14' })).rejects.toMatchObject({ code: 'invalid', message: '结束日期不能晚于今天' });
    await expect(bad({ kind: 'custom', from: '2025-01-01', to: '2026-10-13' })).rejects.toMatchObject({ code: 'invalid', message: '自定义时间段不超过 366 天' });
    await expect(bad({ kind: 'iteration', iterationId: it2 })).rejects.toMatchObject({ code: 'invalid', message: '迭代还没有开始' });
    await expect(bad({ kind: 'iteration', iterationId: docIteration })).rejects.toMatchObject({ code: 'not_found', message: '迭代不存在' });
  });

  it('空产品：各区块为空，没有数据的卡片与上期为 null，周趋势为 0', async () => {
    const dash = await getProductDashboard(t.db, owner, empty, { range: R90, now: NOW });
    expect(dash.cards).toEqual({
      throughputPerWeek: { value: null, previous: null },
      leadTimeMedian: { value: null, previous: null },
      flowTimeMedian: { value: null, previous: null },
      wip: { value: null, previous: null },
      releaseOnTimeRate: { value: null, previous: null },
      rejectionRate: { value: null, previous: null },
    });
    expect(dash.weeks.every((w) => w.throughput === 0 && w.wip === 0 && w.leadP85 === null)).toBe(true);
    expect(dash.stuck).toEqual({ states: [], oldest: [] });
    expect(dash.iterations).toEqual([]);
    expect(dash.releases.rows).toEqual([]);
    expect(dash.specials).toEqual([]);
    expect(dash.iterationOptions).toEqual([]);
  });

  it('能看到产品的成员都可以查看：访客只能看被授权的产品，只读 Token 可以调用', async () => {
    const guest = await asMember(t.db, owner, '访客甲', 'guest');
    await setProductRole(t.db, owner, pan, guest.memberId, 'viewer');
    expect((await getProductDashboard(t.db, guest, pan, { range: R90, now: NOW })).product.key).toBe('PAN');
    await expect(getProductDashboard(t.db, guest, doc, { range: R90, now: NOW })).rejects.toMatchObject({ code: 'not_found', message: '产品不存在' });
    expect((await getProductDashboard(t.db, readOnlyToken(owner), pan, { range: R90, now: NOW })).cards.wip.value).toBe(1);
  });
});

describe('组织汇总', () => {
  it('每个产品一行（按编号前缀排序），关键数字与产品看板一致', async () => {
    const org = await getOrgDashboard(t.db, owner, { range: R90, now: NOW });
    expect(org.window).toMatchObject({ from: '2026-07-16', to: '2026-10-13' });
    expect(org.products.map((p) => p.key)).toEqual(['DOC', 'EMP', 'PAN']);
    const panDash = await getProductDashboard(t.db, owner, pan, { range: R90, now: NOW });
    expect(org.products.find((p) => p.key === 'PAN')).toEqual({ id: pan, key: 'PAN', name: '网盘', cards: panDash.cards, completedCount: 2 });
  });

  it('仅组织管理员：全部产品范围的只读 Token 可以；成员、访客、限定产品的 Token 不可以；不支持按迭代', async () => {
    const member = await asMember(t.db, owner, '成员乙');
    const guest = await asMember(t.db, owner, '访客丙', 'guest');
    const scoped: Actor = { ...owner, tokenId: '00000000-0000-0000-0000-0000000000f2', tokenScope: { products: [pan], access: 'read' } };
    expect((await getOrgDashboard(t.db, readOnlyToken(owner), { range: R90, now: NOW })).products).toHaveLength(3);
    for (const who of [member, guest, scoped]) {
      expect(canViewOrgDashboard(who)).toBe(false);
      await expect(getOrgDashboard(t.db, who, { range: R90, now: NOW })).rejects.toMatchObject({ code: 'forbidden', message: '需要组织管理员权限' });
    }
    await expect(getOrgDashboard(t.db, owner, { range: { kind: 'iteration', iterationId: it1 }, now: NOW })).rejects.toMatchObject({
      code: 'invalid',
      message: '组织汇总不支持按迭代查看',
    });
  });
});
