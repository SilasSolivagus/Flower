import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  domainEvents,
  messageTemplates,
  notificationChannels,
  notificationDeliveries,
  notificationDigestItems,
  notificationRules,
  notificationSchedules,
  organizations,
  products,
} from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import { newId } from '../src/ids';
import { createTestDb } from './db';

let t: Awaited<ReturnType<typeof createTestDb>>;
const orgA = newId();
const orgB = newId();
const productA = newId();
const channel = newId();
const schedule = newId();
const rule = newId();
const event = newId();

beforeAll(async () => {
  t = await createTestDb();
  await t.adminDb.insert(organizations).values([
    { id: orgA, slug: 'a', name: 'A' },
    { id: orgB, slug: 'b', name: 'B' },
  ]);
  await t.adminDb.insert(products).values({ id: productA, orgId: orgA, key: 'AA', name: 'A 产品' });
  await t.adminDb.insert(domainEvents).values({ id: event, orgId: orgA, productId: productA, type: 'requirement.created', subjectType: 'requirement', subjectId: newId(), payload: {} });
});
afterAll(() => t.cleanup());

const TABLES = [notificationChannels, messageTemplates, notificationSchedules, notificationRules, notificationDigestItems, notificationDeliveries];

describe('P3-A 数据模型', () => {
  it('六张表都受行级安全约束，各有一条策略', async () => {
    await withOrg(t.db, orgA, async (tx) => {
      await tx.insert(notificationChannels).values({ id: channel, orgId: orgA, kind: 'wecom_robot', name: '研发群', config: 'v1:a:b:c', configHint: '…/send?key=****0001', rateLimitPerMin: 20 });
      await tx.insert(messageTemplates).values({ orgId: orgA, name: '自定义', format: 'markdown', body: '**{{subject.title}}**' });
      await tx.insert(notificationSchedules).values({ id: schedule, orgId: orgA, productId: productA, name: '摘要', cron: '0 18 * * *', source: 'digest', channelIds: [channel] });
      await tx.insert(notificationRules).values({ id: rule, orgId: orgA, productId: productA, name: '状态变化', eventTypes: ['requirement.state_changed'], mode: 'digest', digestScheduleId: schedule });
      await tx.insert(notificationDigestItems).values({ orgId: orgA, ruleId: rule, scheduleId: schedule, eventId: event });
      await tx.insert(notificationDeliveries).values({ orgId: orgA, kind: 'test', channelId: channel, payload: { type: 'json', body: { msgtype: 'text', text: { content: '测试' } } } });
    });
    for (const table of TABLES) {
      expect(await withOrg(t.db, orgA, (tx) => tx.select().from(table))).toHaveLength(1);
      expect(await withOrg(t.db, orgB, (tx) => tx.select().from(table))).toHaveLength(0);
    }
    const [{ n }] = (await t.adminDb.execute(
      sql`select count(*)::int as n from pg_policies where tablename in ('notification_channels', 'message_templates', 'notification_schedules', 'notification_rules', 'notification_digest_items', 'notification_deliveries')`,
    )) as unknown as [{ n: number }];
    expect(n).toBe(6);
  });

  it('默认值', async () => {
    const [c] = await t.adminDb.select().from(notificationChannels);
    expect(c).toMatchObject({ enabled: true, allowedProductIds: [], groupLabel: null });
    const [s] = await t.adminDb.select().from(notificationSchedules);
    expect(s).toMatchObject({ timezone: 'Asia/Shanghai', failThreshold: 1, consecutiveFailures: 0, alertState: 'normal', enabled: true, nextRunAt: null, sourceConfig: {}, lastError: null });
    const [d] = await t.adminDb.select().from(notificationDeliveries);
    expect(d).toMatchObject({ status: 'pending', attempts: 0, runId: null, legacyKey: null, sentAt: null });
    const [r] = await t.adminDb.select().from(notificationRules);
    expect(r).toMatchObject({ filter: {}, channelIds: [], enabled: true, templateId: null });
  });

  it('约束：摘要规则与摘要定时推送成对；记录的来源与 kind 一致；预置模板与 builtin_key 成对且每种一个；通道同名；摘要条目不重复', async () => {
    await expect(t.adminDb.insert(notificationRules).values({ orgId: orgA, productId: productA, name: 'x', eventTypes: ['requirement.created'], mode: 'digest' })).rejects.toThrow();
    await expect(
      t.adminDb.insert(notificationRules).values({ orgId: orgA, productId: productA, name: 'x', eventTypes: ['requirement.created'], mode: 'immediate', digestScheduleId: schedule }),
    ).rejects.toThrow();
    await expect(t.adminDb.insert(notificationDeliveries).values({ orgId: orgA, kind: 'rule', channelId: channel })).rejects.toThrow();
    await expect(t.adminDb.insert(notificationDeliveries).values({ orgId: orgA, kind: 'test', channelId: channel, scheduleId: schedule })).rejects.toThrow();
    await t.adminDb.insert(notificationDeliveries).values({ orgId: orgA, kind: 'schedule', channelId: channel, scheduleId: schedule });
    await expect(t.adminDb.insert(messageTemplates).values({ orgId: orgA, name: '预置', format: 'markdown', body: 'x', builtin: true })).rejects.toThrow();
    await t.adminDb.insert(messageTemplates).values({ orgId: orgA, name: '默认 · 事件推送', format: 'markdown', body: 'x', builtin: true, builtinKey: 'event' });
    await expect(t.adminDb.insert(messageTemplates).values({ orgId: orgA, name: '另一个', format: 'markdown', body: 'x', builtin: true, builtinKey: 'event' })).rejects.toThrow();
    await expect(t.adminDb.insert(notificationChannels).values({ orgId: orgA, kind: 'webhook', name: '研发群', config: 'v1:a:b:c', configHint: 'h', rateLimitPerMin: 60 })).rejects.toThrow();
    await expect(t.adminDb.insert(notificationDigestItems).values({ orgId: orgA, ruleId: rule, scheduleId: schedule, eventId: event })).rejects.toThrow();
  });
});
