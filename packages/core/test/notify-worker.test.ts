import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { messageTemplates, notificationDeliveries, notificationSchedules } from '../src/db/schema';
import type { Actor } from '../src/domain-types';
import { createMessageTemplate } from '../src/notifications/message-templates';
import { createRule } from '../src/notifications/rules';
import { createSchedule } from '../src/notifications/schedules';
import { createNotificationWorker, runNotificationTick } from '../src/notifications/worker';
import { createRequirement } from '../src/requirements/requirements';
import { createProduct } from '../src/tenancy/products';
import { createTestDb } from './db';
import { seedInstance } from './factories';
import { TEST_DEPS, wecomChannel } from './notify-helpers';
import { fakeTransport } from './notify-transport';

let t: Awaited<ReturnType<typeof createTestDb>>;
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
  ({ owner } = await seedInstance(t.db));
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
