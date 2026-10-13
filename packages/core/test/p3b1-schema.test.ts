import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  domainEvents,
  memberNotificationPrefs,
  memberNotifications,
  members,
  notificationChannels,
  notificationCursors,
  notificationDeliveries,
  notificationSchedules,
  organizations,
  products,
  subscriptions,
  wecomApps,
  wecomBindStates,
} from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import { newId } from '../src/ids';
import { createTestDb } from './db';

let t: Awaited<ReturnType<typeof createTestDb>>;
const orgA = newId();
const orgB = newId();
const productA = newId();
const memberA = newId();
const memberA2 = newId();
const memberB = newId();
const channel = newId();
const event = newId();
const subject = newId();

beforeAll(async () => {
  t = await createTestDb();
  await t.adminDb.insert(organizations).values([
    { id: orgA, slug: 'a', name: 'A' },
    { id: orgB, slug: 'b', name: 'B' },
  ]);
  await t.adminDb.insert(products).values({ id: productA, orgId: orgA, key: 'AA', name: 'A 产品' });
  await t.adminDb.insert(members).values([
    { id: memberA, orgId: orgA, displayName: '张三', orgRole: 'member' },
    { id: memberA2, orgId: orgA, displayName: '李四', orgRole: 'member' },
    { id: memberB, orgId: orgB, displayName: '王五', orgRole: 'member' },
  ]);
  await t.adminDb.insert(domainEvents).values({ id: event, orgId: orgA, productId: productA, type: 'comment.created', subjectType: 'requirement', subjectId: subject, payload: {} });
  await t.adminDb.insert(notificationChannels).values({ id: channel, orgId: orgA, kind: 'wecom_robot', name: '研发群', config: 'v1:a:b:c', configHint: 'h', rateLimitPerMin: 20 });
});
afterAll(() => t.cleanup());

const TABLES = [memberNotifications, memberNotificationPrefs, subscriptions, notificationCursors, wecomApps, wecomBindStates];

describe('P3-B1 数据模型', () => {
  it('六张表都受行级安全约束，各有一条策略', async () => {
    await withOrg(t.db, orgA, async (tx) => {
      await tx.insert(memberNotifications).values({ orgId: orgA, memberId: memberA, eventId: event, kind: 'mentioned', subjectType: 'requirement', subjectId: subject, title: 'AA-1 标题', body: '在评论中 @ 了你', url: '/a/requirements/AA-1' });
      await tx.insert(memberNotificationPrefs).values({ orgId: orgA, memberId: memberA, kind: 'mentioned', inApp: true, wecom: false, email: false });
      await tx.insert(subscriptions).values({ orgId: orgA, memberId: memberA, subjectType: 'requirement', subjectId: subject, source: 'auto' });
      await tx.insert(notificationCursors).values({ orgId: orgA });
      await tx.insert(wecomApps).values({ orgId: orgA, corpId: 'ww0001', agentId: '1000002', secret: 'v1:a:b:c', secretHint: '****0001' });
      await tx.insert(wecomBindStates).values({ orgId: orgA, memberId: memberA, stateHash: 'a'.repeat(64), expiresAt: new Date(Date.now() + 600_000) });
    });
    for (const table of TABLES) {
      expect(await withOrg(t.db, orgA, (tx) => tx.select().from(table))).toHaveLength(1);
      expect(await withOrg(t.db, orgB, (tx) => tx.select().from(table))).toHaveLength(0);
    }
    const [{ n }] = (await t.adminDb.execute(
      sql`select count(*)::int as n from pg_policies where tablename in ('member_notifications', 'member_notification_prefs', 'subscriptions', 'notification_cursors', 'wecom_apps', 'wecom_bind_states')`,
    )) as unknown as [{ n: number }];
    expect(n).toBe(6);
  });

  it('默认值', async () => {
    const [n] = await t.adminDb.select().from(memberNotifications);
    expect(n).toMatchObject({ readAt: null, actorMemberId: null });
    const [c] = await t.adminDb.select().from(notificationCursors);
    expect(c).toMatchObject({ lastOccurredAt: null, lastEventId: null, failingEventId: null, failures: 0 });
    const [w] = await t.adminDb.select().from(wecomApps);
    expect(w).toMatchObject({ bindEnabled: false });
    const [s] = await t.adminDb.select().from(subscriptions);
    expect(s).toMatchObject({ mutedAt: null, source: 'auto' });
    const [m] = await t.adminDb.select().from(members).where(eq(members.id, memberA));
    expect(m!.wecomUserid).toBeNull();
    const [p] = await t.adminDb.select().from(products);
    expect(p!.personalChannelId).toBeNull();
  });

  it('约束：同一人同一事件同一类只一条（系统告警可重复）；偏好、关注、state、企业微信应用唯一', async () => {
    await expect(
      t.adminDb.insert(memberNotifications).values({ orgId: orgA, memberId: memberA, eventId: event, kind: 'mentioned', subjectType: 'requirement', subjectId: subject, title: 't', body: 'b', url: '/u' }),
    ).rejects.toThrow();
    const alert = { orgId: orgA, memberId: memberA, eventId: null, kind: 'system_alert' as const, subjectType: 'schedule' as const, subjectId: newId(), title: 't', body: 'b', url: '/u' };
    await t.adminDb.insert(memberNotifications).values([alert, { ...alert }]);
    await expect(t.adminDb.insert(memberNotificationPrefs).values({ orgId: orgA, memberId: memberA, kind: 'mentioned', inApp: false, wecom: false, email: false })).rejects.toThrow();
    await expect(t.adminDb.insert(subscriptions).values({ orgId: orgA, memberId: memberA, subjectType: 'requirement', subjectId: subject, source: 'manual' })).rejects.toThrow();
    await expect(t.adminDb.insert(wecomBindStates).values({ orgId: orgA, memberId: memberA2, stateHash: 'a'.repeat(64), expiresAt: new Date() })).rejects.toThrow();
    await expect(t.adminDb.insert(wecomApps).values({ orgId: orgA, corpId: 'ww2', agentId: '2', secret: 'v1:x', secretHint: '****' })).rejects.toThrow();
  });

  it('企业微信账号在同一组织内唯一，不同组织可以相同', async () => {
    await t.adminDb.update(members).set({ wecomUserid: 'zhangsan' }).where(eq(members.id, memberA));
    await expect(t.adminDb.update(members).set({ wecomUserid: 'zhangsan' }).where(eq(members.id, memberA2))).rejects.toThrow();
    await t.adminDb.update(members).set({ wecomUserid: 'zhangsan' }).where(eq(members.id, memberB));
  });

  it('发送记录接受个人提醒（不属于规则与定时推送）', async () => {
    await t.adminDb.insert(notificationDeliveries).values({ orgId: orgA, kind: 'personal', channelId: channel, payload: { type: 'json', body: { msgtype: 'markdown', markdown: { content: 'x' } } } });
    const schedule = newId();
    await t.adminDb.insert(notificationSchedules).values({ id: schedule, orgId: orgA, productId: productA, name: '摘要', cron: '0 18 * * *', source: 'digest', channelIds: [channel] });
    await expect(t.adminDb.insert(notificationDeliveries).values({ orgId: orgA, kind: 'personal', channelId: channel, scheduleId: schedule })).rejects.toMatchObject({
      cause: { constraint_name: 'notification_deliveries_source' },
    });
  });

  it('个人提醒通道与个人通知邮件通道在通道删除时置空', async () => {
    const ch = newId();
    await t.adminDb.insert(notificationChannels).values({ id: ch, orgId: orgA, kind: 'wecom_robot', name: '临时群', config: 'v1:a:b:c', configHint: 'h', rateLimitPerMin: 20 });
    await t.adminDb.update(products).set({ personalChannelId: ch }).where(eq(products.id, productA));
    await t.adminDb.update(organizations).set({ personalEmailChannelId: ch }).where(eq(organizations.id, orgA));
    await t.adminDb.delete(notificationChannels).where(eq(notificationChannels.id, ch));
    expect((await t.adminDb.select().from(products).where(eq(products.id, productA)))[0]!.personalChannelId).toBeNull();
    expect((await t.adminDb.select().from(organizations).where(eq(organizations.id, orgA)))[0]!.personalEmailChannelId).toBeNull();
  });
});
