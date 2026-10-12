import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { memberNotifications, messageTemplates, notificationDeliveries, notificationRules, notificationSchedules } from '../src/db/schema';
import type { AccountView } from '../src/auth/accounts';
import type { Actor } from '../src/domain-types';
import { newId } from '../src/ids';
import { notifyScheduleAlertTx } from '../src/member-notifications/alerts';
import { createMessageTemplate } from '../src/notifications/message-templates';
import { createRule } from '../src/notifications/rules';
import { createSchedule } from '../src/notifications/schedules';
import { createNotificationWorker, runNotificationTick } from '../src/notifications/worker';
import { createRequirement } from '../src/requirements/requirements';
import { createOrganization, resolveActor } from '../src/tenancy/orgs';
import { createProduct } from '../src/tenancy/products';
import { createTestDb } from './db';
import { seedInstance } from './factories';
import { TEST_DEPS, wecomChannel } from './notify-helpers';
import { fakeTransport } from './notify-transport';

// 默认调用原实现；个别用例改成出错，验证后台循环的隔离
vi.mock('../src/member-notifications/alerts', async (importOriginal) => {
  const m = await importOriginal<typeof import('../src/member-notifications/alerts')>();
  return { ...m, notifyScheduleAlertTx: vi.fn(m.notifyScheduleAlertTx) };
});

let t: Awaited<ReturnType<typeof createTestDb>>;
let account: AccountView;
let owner: Actor;
let productId: string;
let channelId: string;
const fake = fakeTransport();
const deps = { ...TEST_DEPS, transport: fake.transport };
const URL_ = 'http://127.0.0.1:9/cgi-bin/webhook/send?key=worker-0001';
const schedule = async (id: string) => (await t.adminDb.select().from(notificationSchedules).where(eq(notificationSchedules.id, id)))[0]!;
const deliveriesOf = (id: string) => t.adminDb.select().from(notificationDeliveries).where(eq(notificationDeliveries.scheduleId, id));
let seq = 0;
const overview = async (extra: Record<string, unknown> = {}) =>
  createSchedule(t.db, owner, { productId, name: `日报 ${++seq}`, cron: '0 19 * * 1-5', source: 'overview_card', channelIds: [channelId], ...extra });

async function until(check: () => Promise<boolean>, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('等待超时');
}

beforeAll(async () => {
  t = await createTestDb();
  ({ account, owner } = await seedInstance(t.db));
  productId = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  channelId = (await wecomChannel(t.db, owner, '研发群', { url: URL_, rateLimitPerMin: 100 })).id;
});
afterAll(() => t.cleanup());
beforeEach(() => fake.reset(() => ({ status: 200, text: '{"errcode":0,"errmsg":"ok"}' })));

describe('一轮处理', () => {
  it('没有排期的启用定时推送只排期、不补跑', async () => {
    const s = await overview();
    await t.adminDb.update(notificationSchedules).set({ nextRunAt: null }).where(eq(notificationSchedules.id, s.id));
    const now = new Date('2026-10-12T12:00:00Z');
    await runNotificationTick(t.db, deps, now);
    expect((await schedule(s.id)).nextRunAt!.toISOString()).toBe('2026-10-13T11:00:00.000Z');
    expect(await deliveriesOf(s.id)).toHaveLength(0);
    // 停用，免得后面的用例按真实时间运行时把它当成到点
    await t.adminDb.update(notificationSchedules).set({ enabled: false }).where(eq(notificationSchedules.id, s.id));
  });

  it('到点的执行一次并发送，按本次时间算下一次；未到点与停用的不执行', async () => {
    const due = await overview();
    const notDue = await overview();
    const off = await overview({ enabled: false });
    const now = new Date();
    await t.adminDb.update(notificationSchedules).set({ nextRunAt: new Date(now.getTime() - 1000) }).where(eq(notificationSchedules.id, due.id));
    await t.adminDb.update(notificationSchedules).set({ nextRunAt: new Date(now.getTime() + 3_600_000) }).where(eq(notificationSchedules.id, notDue.id));
    const summary = await runNotificationTick(t.db, deps, now);
    expect(summary).toMatchObject({ schedulesRun: 1, sent: 1 });
    expect((await deliveriesOf(due.id)).map((d) => d.status)).toEqual(['sent']);
    const after = await schedule(due.id);
    expect(after.lastRunAt!.getTime()).toBe(now.getTime());
    expect(after.nextRunAt!.getTime()).toBeGreaterThan(now.getTime());
    expect(await deliveriesOf(notDue.id)).toHaveLength(0);
    expect(await deliveriesOf(off.id)).toHaveLength(0);
  });

  it('两个实例同时到点：同一定时推送只执行一次', async () => {
    const s = await overview();
    const now = new Date();
    await t.adminDb.update(notificationSchedules).set({ nextRunAt: new Date(now.getTime() - 1000) }).where(eq(notificationSchedules.id, s.id));
    await Promise.all([runNotificationTick(t.db, deps, now), runNotificationTick(t.db, deps, now)]);
    expect(await deliveriesOf(s.id)).toHaveLength(1);
  });

  it('生成出错：不写记录，记 last_error、连续失败加一并告警，推进下一次', async () => {
    const tpl = await createMessageTemplate(t.db, owner, { name: '会坏的模板', format: 'markdown', body: '{{title}}' });
    const s = await overview({ templateId: tpl.id });
    await t.adminDb.update(messageTemplates).set({ body: '{{#title}}' }).where(eq(messageTemplates.id, tpl.id));
    const now = new Date();
    await t.adminDb.update(notificationSchedules).set({ nextRunAt: new Date(now.getTime() - 1000) }).where(eq(notificationSchedules.id, s.id));
    await runNotificationTick(t.db, deps, now);
    const after = await schedule(s.id);
    expect(after).toMatchObject({ consecutiveFailures: 1, alertState: 'alert' });
    expect(after.lastError).toMatch(/^生成内容失败：模板语法错误/);
    expect(after.nextRunAt!.getTime()).toBeGreaterThan(now.getTime());
    expect(await deliveriesOf(s.id)).toHaveLength(0);
  });
  it('一个组织的定时推送 cron 无效：停用并告警，同一轮其他组织照常执行与发送', async () => {
    await createOrganization(t.db, account, { name: '第二组织', slug: 'other' });
    const other = (await resolveActor(t.db, account.id, 'other'))!;
    const otherProduct = await createProduct(t.db, other, { name: '相册', key: 'ALB' });
    const otherChannel = await wecomChannel(t.db, other, '相册群', { url: URL_, rateLimitPerMin: 100 });
    const bad = await createSchedule(t.db, other, { productId: otherProduct.id, name: '坏日报', cron: '0 19 * * 1-5', source: 'overview_card', channelIds: [otherChannel.id] });
    const due = await overview();
    const rule = await createRule(t.db, owner, productId, { name: '跨组织规则', eventTypes: ['requirement.created'], channelIds: [channelId] });
    await createRequirement(t.db, owner, productId, { title: '另一个组织照常发送' });
    const now = new Date();
    // 绕过 assertCron 直接写入无效的 cron（迁移导入的数据不经过校验）
    await t.adminDb.update(notificationSchedules).set({ cron: 'not a cron', nextRunAt: new Date(now.getTime() - 1000) }).where(eq(notificationSchedules.id, bad.id));
    await t.adminDb.update(notificationSchedules).set({ nextRunAt: new Date(now.getTime() - 1000) }).where(eq(notificationSchedules.id, due.id));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const summary = await runNotificationTick(t.db, deps, now);
      expect(summary).toMatchObject({ orgs: 2, schedulesRun: 1, sent: 2 });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`schedule=${bad.id}`));
    } finally {
      warn.mockRestore();
    }
    expect((await deliveriesOf(due.id)).map((d) => d.status)).toEqual(['sent']);
    const ruleRows = await t.adminDb.select().from(notificationDeliveries).where(eq(notificationDeliveries.ruleId, rule.id));
    expect(ruleRows.map((d) => d.status)).toEqual(['sent']);
    const after = await schedule(bad.id);
    expect(after).toMatchObject({ enabled: false, nextRunAt: null, alertState: 'alert', consecutiveFailures: 1 });
    expect(after.lastError).toMatch(/^定时规则或时区无效，已停用/);
    expect(await deliveriesOf(bad.id)).toHaveLength(0);
    // 停用本用例的规则，免得后面的循环用例多发一条
    await t.adminDb.update(notificationRules).set({ enabled: false }).where(eq(notificationRules.id, rule.id));
  });
});

describe('循环', () => {
  it('启动后按间隔处理；stop 之后不再取新任务', async () => {
    const rule = await createRule(t.db, owner, productId, { name: '循环规则', eventTypes: ['requirement.created'], channelIds: [channelId] });
    const worker = createNotificationWorker(t.db, deps, { intervalMs: 20 });
    worker.start();
    await createRequirement(t.db, owner, productId, { title: '循环发送' });
    await until(async () => fake.calls.length === 1);
    await worker.stop();
    await createRequirement(t.db, owner, productId, { title: '停了以后' });
    await new Promise((r) => setTimeout(r, 150));
    expect(fake.calls).toHaveLength(1);
    const rows = await t.adminDb.select().from(notificationDeliveries).where(eq(notificationDeliveries.ruleId, rule.id));
    expect(rows.map((r) => r.status).sort()).toEqual(['pending', 'sent']);
  });
});

describe('系统告警写入出错', () => {
  const alertMock = vi.mocked(notifyScheduleAlertTx);
  /** 告警写入在数据库里出错（不放 savepoint 时整个事务会中止）。 */
  async function withFailingAlert(run: (warn: MockInstance<typeof console.warn>) => Promise<void>): Promise<void> {
    const original = alertMock.getMockImplementation()!;
    alertMock.mockImplementation(async (tx) => {
      await tx.execute(sql`select 1 / 0`);
      return 0;
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await run(warn);
    } finally {
      warn.mockRestore();
      alertMock.mockImplementation(original);
    }
  }
  const alertWarnings = (warn: MockInstance<typeof console.warn>) => warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('系统告警通知写入失败'));
  const contentOf = (c: { body: Record<string, unknown> }) => (c.body.text as { content?: string } | undefined)?.content;

  it('发送结算与租约回收时出错：结算照常提交，不重复发送，同一组织其余记录照常发出', async () => {
    const reclaimed = await overview({ enabled: false, failThreshold: 1 });
    const sentDead = await overview({ enabled: false, failThreshold: 1 });
    const healthy = await overview({ enabled: false });
    const row = (scheduleId: string, content: string, extra: Partial<typeof notificationDeliveries.$inferInsert>) => ({
      orgId: owner.orgId,
      kind: 'schedule' as const,
      scheduleId,
      runId: newId(),
      channelId,
      payload: { type: 'json' as const, body: { msgtype: 'text', text: { content } } },
      attempts: 4,
      nextAttemptAt: new Date(Date.now() - 1000),
      ...extra,
    });
    // 租约到期的发送中记录（在认领事务里回收并放弃）、发送失败后放弃的记录、正常的待发记录
    await t.adminDb.insert(notificationDeliveries).values([
      row(reclaimed.id, '回收', { status: 'sending' }),
      row(sentDead.id, '会失败', { status: 'failed' }),
      row(healthy.id, '正常', { status: 'pending', attempts: 0 }),
    ]);
    fake.reset((c) => (contentOf(c) === '会失败' ? { status: 500, text: 'boom' } : { status: 200, text: '{"errcode":0,"errmsg":"ok"}' }));
    await withFailingAlert(async (warn) => {
      const now = new Date();
      await runNotificationTick(t.db, deps, now);
      await runNotificationTick(t.db, deps, new Date(now.getTime() + 2 * 3_600_000));
      expect(alertWarnings(warn)).toHaveLength(2);
      for (const m of alertWarnings(warn)) expect(m).not.toMatch(/select|1 \/ 0/);
    });
    expect((await deliveriesOf(reclaimed.id)).map((d) => d.status)).toEqual(['dead']);
    expect((await deliveriesOf(sentDead.id)).map((d) => d.status)).toEqual(['dead']);
    expect((await deliveriesOf(healthy.id)).map((d) => d.status)).toEqual(['sent']);
    for (const id of [reclaimed.id, sentDead.id]) expect(await schedule(id)).toMatchObject({ alertState: 'alert', consecutiveFailures: 1 });
    expect(fake.calls.map(contentOf).filter((c) => c === '会失败' || c === '回收')).toEqual(['会失败']);
    expect(fake.calls.map(contentOf).filter((c) => c === '正常')).toEqual(['正常']);
    expect(await t.adminDb.select().from(memberNotifications).where(eq(memberNotifications.subjectId, sentDead.id))).toHaveLength(0);
  });

  it('定时推送生成失败与 cron 无效时出错：失败记录与停用照常提交，同一轮其余定时推送照常执行与发送', async () => {
    const tpl = await createMessageTemplate(t.db, owner, { name: '告警用的坏模板', format: 'markdown', body: '{{title}}' });
    const broken = await overview({ templateId: tpl.id, failThreshold: 1 });
    await t.adminDb.update(messageTemplates).set({ body: '{{#title}}' }).where(eq(messageTemplates.id, tpl.id));
    const badCron = await overview();
    const healthy = await overview();
    const now = new Date();
    const past = new Date(now.getTime() - 1000);
    await t.adminDb.update(notificationSchedules).set({ nextRunAt: past }).where(eq(notificationSchedules.id, broken.id));
    await t.adminDb.update(notificationSchedules).set({ cron: 'not a cron', nextRunAt: past }).where(eq(notificationSchedules.id, badCron.id));
    await t.adminDb.update(notificationSchedules).set({ nextRunAt: past }).where(eq(notificationSchedules.id, healthy.id));
    await withFailingAlert(async (warn) => {
      const summary = await runNotificationTick(t.db, deps, now);
      expect(summary).toMatchObject({ schedulesRun: 1, sent: 1 });
      expect(alertWarnings(warn)).toHaveLength(2);
    });
    const b = await schedule(broken.id);
    expect(b).toMatchObject({ consecutiveFailures: 1, alertState: 'alert' });
    expect(b.nextRunAt!.getTime()).toBeGreaterThan(now.getTime());
    expect(await schedule(badCron.id)).toMatchObject({ enabled: false, nextRunAt: null, alertState: 'alert' });
    expect((await deliveriesOf(healthy.id)).map((d) => d.status)).toEqual(['sent']);
    await t.adminDb.update(notificationSchedules).set({ enabled: false }).where(inArray(notificationSchedules.id, [broken.id, healthy.id]));
  });
});
