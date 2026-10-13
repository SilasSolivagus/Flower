import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { memberNotifications, notificationDeliveries, notificationSchedules, wecomBindStates } from '../src/db/schema';
import type { Actor } from '../src/domain-types';
import { newId } from '../src/ids';
import {
  countMyUnread,
  listMyNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  markSubjectNotificationsRead,
} from '../src/member-notifications/inbox';
import { createSchedule } from '../src/notifications/schedules';
import { runNotificationTick } from '../src/notifications/worker';
import { createRequirement } from '../src/requirements/requirements';
import { updateMember } from '../src/tenancy/members';
import { createProduct } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, readOnlyToken, seedInstance } from './factories';
import { TEST_DEPS, wecomChannel } from './notify-helpers';
import { fakeTransport } from './notify-transport';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let a: Actor;
let productId: string;
let reqId: string;
const fake = fakeTransport();
const deps = { ...TEST_DEPS, transport: fake.transport };
const tick = (now?: Date) => runNotificationTick(t.db, deps, now);
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
const ids: Record<string, string> = {};

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  productId = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  a = await asMember(t.db, owner, '张三');
  reqId = (await createRequirement(t.db, owner, productId, { title: '登录页改版' })).id;
  await tick();
  const base = { orgId: owner.orgId, memberId: a.memberId, subjectType: 'requirement' as const, subjectId: reqId, title: 'PAN-1 登录页改版', url: '/acme/requirements/PAN-1' };
  const rows = [
    { key: 'n1', kind: 'mentioned' as const, body: '在评论中 @ 了你', createdAt: minutesAgo(5), actorMemberId: owner.memberId },
    { key: 'n2', kind: 'assigned' as const, body: '把你设为需求负责人', createdAt: minutesAgo(4), actorMemberId: owner.memberId },
    { key: 'n3', kind: 'followed_change' as const, body: '把状态从「待处理」改为「进行中」', createdAt: minutesAgo(3), actorMemberId: owner.memberId, readAt: minutesAgo(1) },
    { key: 'n4', kind: 'mentioned' as const, body: '在需求描述中 @ 了你', createdAt: minutesAgo(2), actorMemberId: owner.memberId },
    { key: 'n5', kind: 'signoff_due' as const, body: '「设计签字」等你签字', createdAt: minutesAgo(1), actorMemberId: null },
  ];
  for (const { key, ...r } of rows) {
    const [row] = await t.adminDb.insert(memberNotifications).values({ ...base, ...r }).returning({ id: memberNotifications.id });
    ids[key] = row!.id;
  }
});
afterAll(() => t.cleanup());
beforeEach(() => fake.reset(() => ({ status: 200, text: '{"errcode":0,"errmsg":"ok"}' })));

describe('通知列表', () => {
  it('按时间倒序分页；操作人显示当前姓名；没有操作人时为空', async () => {
    await updateMember(t.db, owner, owner.memberId, { displayName: '林澄' });
    const p1 = await listMyNotifications(t.db, a, { limit: 2 });
    expect(p1.notifications.map((n) => n.id)).toEqual([ids.n5, ids.n4]);
    expect(p1.notifications[0]!.actor).toBeNull();
    expect(p1.notifications[1]!.actor).toEqual({ id: owner.memberId, displayName: '林澄' });
    const p2 = await listMyNotifications(t.db, a, { limit: 2, before: p1.nextCursor! });
    expect(p2.notifications.map((n) => n.id)).toEqual([ids.n3, ids.n2]);
    const p3 = await listMyNotifications(t.db, a, { limit: 2, before: p2.nextCursor! });
    expect(p3).toEqual({ notifications: [expect.objectContaining({ id: ids.n1 })], nextCursor: null });
    await expect(listMyNotifications(t.db, a, { before: 'x' })).rejects.toThrow('分页参数无效');
  });

  it('筛选：未读、@我、按类型；别人看不到', async () => {
    expect((await listMyNotifications(t.db, a, { filter: 'unread' })).notifications.map((n) => n.id)).toEqual([ids.n5, ids.n4, ids.n2, ids.n1]);
    expect((await listMyNotifications(t.db, a, { filter: 'mentioned' })).notifications.map((n) => n.id)).toEqual([ids.n4, ids.n1]);
    expect((await listMyNotifications(t.db, a, { kind: 'assigned' })).notifications.map((n) => n.id)).toEqual([ids.n2]);
    expect((await listMyNotifications(t.db, owner, {})).notifications).toEqual([]);
  });
});

describe('已读', () => {
  it('未读数；标一条；按对象标已读；全部标为已读', async () => {
    expect(await countMyUnread(t.db, a)).toBe(4);
    await markNotificationRead(t.db, a, ids.n5!);
    expect(await countMyUnread(t.db, a)).toBe(3);
    expect(await markSubjectNotificationsRead(t.db, a, { type: 'requirement', id: reqId })).toBe(3);
    expect(await countMyUnread(t.db, a)).toBe(0);
    await t.adminDb.update(memberNotifications).set({ readAt: null }).where(eq(memberNotifications.id, ids.n1!));
    expect(await markAllNotificationsRead(t.db, a)).toBe(1);
  });

  it('别人的通知报不存在；只读 Token 能看不能标', async () => {
    await expect(markNotificationRead(t.db, owner, ids.n1!)).rejects.toThrow('通知不存在');
    const token = readOnlyToken(a);
    expect((await listMyNotifications(t.db, token, {})).notifications).toHaveLength(5);
    await expect(markAllNotificationsRead(t.db, token)).rejects.toThrow('只读 Token 不能标记已读');
  });
});

describe('清理', () => {
  it('后台循环删除已读超过 90 天的通知；未读与较新的保留', async () => {
    const day = 86_400_000;
    const now = new Date();
    const base = { orgId: owner.orgId, memberId: a.memberId, kind: 'mentioned' as const, subjectType: 'requirement' as const, subjectId: reqId, title: 't', body: 'b', url: '/u' };
    const [oldRead] = await t.adminDb.insert(memberNotifications).values({ ...base, createdAt: new Date(now.getTime() - 120 * day), readAt: new Date(now.getTime() - 91 * day) }).returning();
    const [recentRead] = await t.adminDb.insert(memberNotifications).values({ ...base, createdAt: new Date(now.getTime() - 120 * day), readAt: new Date(now.getTime() - 89 * day) }).returning();
    const [oldUnread] = await t.adminDb.insert(memberNotifications).values({ ...base, createdAt: new Date(now.getTime() - 200 * day) }).returning();
    const summary = await tick(now);
    expect(summary.orgs).toBe(1);
    const left = (await t.adminDb.select({ id: memberNotifications.id }).from(memberNotifications)).map((r) => r.id);
    expect(left).not.toContain(oldRead!.id);
    expect(left).toEqual(expect.arrayContaining([recentRead!.id, oldUnread!.id]));
  });
});

describe('清理扫码绑定 state', () => {
  it('删除过期超过 1 天的 state；较新的保留', async () => {
    const day = 86_400_000;
    const now = new Date();
    const base = { orgId: owner.orgId, memberId: a.memberId };
    const [old] = await t.adminDb.insert(wecomBindStates).values({ ...base, stateHash: 'h-old', expiresAt: new Date(now.getTime() - 2 * day) }).returning();
    const [fresh] = await t.adminDb.insert(wecomBindStates).values({ ...base, stateHash: 'h-fresh', expiresAt: new Date(now.getTime() - 0.5 * day) }).returning();
    await tick(now);
    const left = (await t.adminDb.select({ id: wecomBindStates.id }).from(wecomBindStates)).map((r) => r.id);
    expect(left).not.toContain(old!.id);
    expect(left).toContain(fresh!.id);
  });
});

describe('系统告警', () => {
  it('一次执行全部放弃使定时推送进入告警：给在职的组织管理员写一条，普通成员不收；已在告警时不重复', async () => {
    const admin = await asMember(t.db, owner, '管理员乙');
    await updateMember(t.db, owner, admin.memberId, { orgRole: 'admin' });
    const ch = await wecomChannel(t.db, owner, '日报群');
    const s = await createSchedule(t.db, owner, { productId, name: '日报', cron: '0 19 * * 1-5', source: 'overview_card', channelIds: [ch.id], enabled: false, failThreshold: 1 });
    const failing = () =>
      t.adminDb.insert(notificationDeliveries).values({
        orgId: owner.orgId,
        kind: 'schedule',
        scheduleId: s.id,
        runId: newId(),
        channelId: ch.id,
        payload: { type: 'json', body: { msgtype: 'text', text: { content: '日报' } } },
        status: 'failed',
        attempts: 4,
        nextAttemptAt: new Date(Date.now() - 1000),
      });
    fake.reset(() => ({ status: 500, text: 'boom' }));
    await failing();
    await tick();
    expect((await t.adminDb.select().from(notificationSchedules).where(eq(notificationSchedules.id, s.id)))[0]!.alertState).toBe('alert');
    const alerts = await t.adminDb.select().from(memberNotifications).where(eq(memberNotifications.kind, 'system_alert'));
    expect(alerts.map((n) => n.memberId).sort()).toEqual([owner.memberId, admin.memberId].sort());
    expect(alerts[0]).toMatchObject({
      eventId: null,
      subjectType: 'schedule',
      subjectId: s.id,
      title: '定时推送「日报」',
      body: '连续失败 1 次，已进入告警',
      url: '/acme/settings/notifications?tab=schedules',
      actorMemberId: null,
    });
    await failing();
    await tick();
    expect(await t.adminDb.select().from(memberNotifications).where(eq(memberNotifications.kind, 'system_alert'))).toHaveLength(2);
  });

  it('定时规则无效被停用时也告警', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ch = await wecomChannel(t.db, owner, '周报群');
    const s = await createSchedule(t.db, owner, { productId, name: '周报', cron: '0 19 * * 5', source: 'overview_card', channelIds: [ch.id] });
    await t.adminDb.update(notificationSchedules).set({ cron: 'not a cron', nextRunAt: new Date(Date.now() - 1000) }).where(eq(notificationSchedules.id, s.id));
    await tick();
    const [n] = await t.adminDb.select().from(memberNotifications).where(eq(memberNotifications.subjectId, s.id));
    expect(n).toMatchObject({ kind: 'system_alert', memberId: expect.any(String), body: '定时规则或时区无效，已停用并进入告警' });
    warn.mockRestore();
  });
});
