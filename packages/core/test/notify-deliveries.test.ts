import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { domainEvents, notificationDeliveries, notificationDigestItems, notificationSchedules } from '../src/db/schema';
import type { Actor } from '../src/domain-types';
import { createChannel, updateChannel } from '../src/notifications/channels';
import { listDeliveries, processDueDeliveries, resendDelivery, sendTestMessage } from '../src/notifications/deliveries';
import { createMessageTemplate } from '../src/notifications/message-templates';
import { createRule } from '../src/notifications/rules';
import { runScheduleNow } from '../src/notifications/run';
import { createSchedule } from '../src/notifications/schedules';
import { classifyHttp, retryDelayMs, sendPayload, signWebhook, type Transport } from '../src/notifications/sender';
import { createRequirement } from '../src/requirements/requirements';
import { transitionRequirement } from '../src/requirements/transitions';
import { createProduct } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, seedInstance } from './factories';
import { TEST_DEPS, wecomChannel } from './notify-helpers';
import { fakeTransport } from './notify-transport';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
const fake = fakeTransport();
const deps = { ...TEST_DEPS, transport: fake.transport };
const OK = { status: 200, text: '{"errcode":0,"errmsg":"ok"}' };
const BAD = { status: 200, text: '{"errcode":93000,"errmsg":"invalid webhook url"}' };
const LIMITED = { status: 200, text: '{"errcode":45009,"errmsg":"api freq out of limit"}' };
/** 每个用例用自己的地址（都指向本机不可达端口，只经假发送器）。 */
const url = (name: string) => `http://127.0.0.1:9/cgi-bin/webhook/send?key=${name}-0001`;
const callsTo = (u: string) => fake.calls.filter((c) => c.url === u);
const row = async (id: string) => (await t.adminDb.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, id)))[0]!;
const ofRule = (ruleId: string) => t.adminDb.select().from(notificationDeliveries).where(eq(notificationDeliveries.ruleId, ruleId));
const process = (now: Date) => processDueDeliveries(t.db, owner.orgId, deps, now);
const later = (ms = 1000) => new Date(Date.now() + ms);
let seq = 0;
const newProduct = async () => (await createProduct(t.db, owner, { name: `产品${++seq}`, key: `P${seq}X` })).id;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
});
afterAll(() => t.cleanup());
beforeEach(() => fake.reset(() => OK));

describe('发送结果判断', () => {
  it('企微 errcode、HTTP 状态、Webhook、重试间隔、签名', () => {
    expect(classifyHttp('wecom_robot', OK).result).toBe('sent');
    expect(classifyHttp('wecom_robot', BAD).result).toBe('failed');
    expect(classifyHttp('wecom_robot', LIMITED).result).toBe('rate_limited');
    expect(classifyHttp('wecom_robot', { status: 429, text: '' }).result).toBe('rate_limited');
    expect(classifyHttp('wecom_robot', { status: 502, text: 'bad gateway' })).toEqual({ result: 'failed', response: 'HTTP 502 bad gateway' });
    expect(classifyHttp('wecom_robot', { status: 200, text: 'not json' }).result).toBe('failed');
    expect(classifyHttp('webhook', { status: 204, text: '' }).result).toBe('sent');
    expect([1, 2, 3, 4, 5].map(retryDelayMs)).toEqual([30_000, 120_000, 600_000, 3_600_000, null]);
    expect(signWebhook('k', '1700000000', '{}')).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('发送前重新检查目标：本机或内网的网址与 SMTP 服务器按失败处理，不发出', async () => {
    const json = { type: 'json' as const, body: { msgtype: 'text', text: { content: 'x' } } };
    const mail = { type: 'email' as const, subject: 's', text: 't' };
    const smtp = { host: 'localhost', port: 465, secure: true, user: 'robot@example.com', pass: 'demo-pass', from: 'robot@example.com', to: ['pm@example.com'] };
    vi.stubEnv('FLOWER_NOTIFY_ALLOW_PRIVATE', '');
    try {
      expect(await sendPayload('wecom_robot', { url: 'http://127.0.0.1:9/send?key=k' }, json, fake.transport, new Date())).toEqual({ result: 'failed', response: '网址不能指向本机或内网地址' });
      expect(await sendPayload('webhook', { url: 'http://10.0.0.8/hook' }, json, fake.transport, new Date())).toEqual({ result: 'failed', response: '网址不能指向本机或内网地址' });
      expect(await sendPayload('email', smtp, mail, fake.transport, new Date())).toEqual({ result: 'failed', response: 'SMTP 服务器不能是本机或内网地址' });
    } finally {
      vi.unstubAllEnvs();
    }
    expect(fake.calls).toHaveLength(0);
    expect(fake.mails).toHaveLength(0);
  });
});

describe('测试消息', () => {
  it('同步发送一次并返回结果；失败直接放弃；停用的通道不能发；只有组织管理员；邮件与 Webhook 签名', async () => {
    const ch = await wecomChannel(t.db, owner, '测试群', { url: url('test') });
    const view = await sendTestMessage(t.db, owner, ch.id, deps);
    expect(view).toMatchObject({ kind: 'test', status: 'sent', attempts: 1, channel: { id: ch.id, name: '测试群', kind: 'wecom_robot' }, source: { type: 'test', name: null, alert: false } });
    const [call] = callsTo(url('test'));
    expect((call!.body.text as { content: string }).content).toMatch(/^Flower 测试消息：通道「测试群」可以正常接收推送。\n发送时间：\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(JSON.stringify(view)).not.toContain('127.0.0.1');

    fake.reset(() => BAD);
    expect(await sendTestMessage(t.db, owner, ch.id, deps)).toMatchObject({ status: 'dead', attempts: 1 });
    await updateChannel(t.db, owner, ch.id, { enabled: false }, TEST_DEPS);
    await expect(sendTestMessage(t.db, owner, ch.id, deps)).rejects.toThrow('通道已停用，启用后才能发送测试消息');
    const member = await asMember(t.db, owner, '成员己');
    await expect(sendTestMessage(t.db, member, ch.id, deps)).rejects.toThrow('需要组织管理员权限');

    fake.reset(() => OK);
    const mail = await createChannel(
      t.db,
      owner,
      { kind: 'email', name: '测试邮件', config: { host: 'smtp.example.com', port: 465, secure: true, user: 'robot@example.com', pass: 'demo-pass', from: 'robot@example.com', to: ['pm@example.com'] } },
      TEST_DEPS,
    );
    expect((await sendTestMessage(t.db, owner, mail.id, deps)).status).toBe('sent');
    expect(fake.mails[0]).toMatchObject({ to: ['pm@example.com'], subject: 'Flower 测试消息：通道「测试邮件」可以正常接收推送。' });
    const hook = await createChannel(t.db, owner, { kind: 'webhook', name: '签名 Webhook', config: { url: 'http://127.0.0.1:9/hooks/flower', secret: 's3cret' } }, TEST_DEPS);
    await sendTestMessage(t.db, owner, hook.id, deps);
    const [signed] = callsTo('http://127.0.0.1:9/hooks/flower');
    expect(signed!.body).toMatchObject({ format: 'text' });
    expect(signed!.headers['x-flower-signature']).toBe(signWebhook('s3cret', signed!.headers['x-flower-timestamp']!, JSON.stringify(signed!.body)));
  });
});

describe('后台发送', () => {
  it('事件规则的记录在发送前渲染；失败后按 30 秒、2 分钟、10 分钟、1 小时重试，第 5 次失败放弃', async () => {
    const productId = await newProduct();
    const ch = await wecomChannel(t.db, owner, '重试群', { url: url('retry') });
    const rule = await createRule(t.db, owner, productId, { name: '重试规则', eventTypes: ['requirement.created'], channelIds: [ch.id] });
    const req = await createRequirement(t.db, owner, productId, { title: '重试的需求' });
    const [d] = await ofRule(rule.id);
    fake.reset(() => BAD);
    let now = later();
    const waits = [30, 120, 600, 3600];
    for (let i = 0; i < 4; i++) {
      await process(now);
      const cur = await row(d!.id);
      expect(cur).toMatchObject({ status: 'failed', attempts: i + 1 });
      expect(cur.nextAttemptAt!.getTime() - now.getTime()).toBe(waits[i]! * 1000);
      await process(new Date(now.getTime() + 1000));
      expect((await row(d!.id)).attempts).toBe(i + 1);
      now = new Date(cur.nextAttemptAt!.getTime() + 1);
    }
    await process(now);
    expect(await row(d!.id)).toMatchObject({ status: 'dead', attempts: 5, nextAttemptAt: null });
    expect(callsTo(url('retry'))).toHaveLength(5);
    const body = callsTo(url('retry'))[0]!.body;
    expect((body.markdown as { content: string }).content).toContain(`[${req.displayKey} 重试的需求](http://flower.example.com/acme/requirements/${req.displayKey})`);
    expect((await row(d!.id)).payload).toEqual({ type: 'json', body });
  });

  it('企微限流应答：回到待发送，60 秒后再试，不计次数', async () => {
    const productId = await newProduct();
    const ch = await wecomChannel(t.db, owner, '限流应答群', { url: url('limited') });
    const rule = await createRule(t.db, owner, productId, { name: '限流规则', eventTypes: ['requirement.created'], channelIds: [ch.id] });
    await createRequirement(t.db, owner, productId, { title: '会被限流' });
    fake.reset(() => LIMITED);
    const now = later();
    await process(now);
    const [d] = await ofRule(rule.id);
    expect(d).toMatchObject({ status: 'pending', attempts: 0 });
    expect(d!.nextAttemptAt!.getTime() - now.getTime()).toBe(60_000);
    expect(d!.response).toContain('45009');
  });

  it('每分钟上限：超出的留到下一轮', async () => {
    const productId = await newProduct();
    const ch = await wecomChannel(t.db, owner, '上限群', { url: url('window'), rateLimitPerMin: 2 });
    const rule = await createRule(t.db, owner, productId, { name: '上限规则', eventTypes: ['requirement.created'], channelIds: [ch.id] });
    for (const title of ['一', '二', '三']) await createRequirement(t.db, owner, productId, { title });
    const now = later();
    await process(now);
    expect(callsTo(url('window'))).toHaveLength(2);
    expect((await ofRule(rule.id)).map((d) => d.status).sort()).toEqual(['pending', 'sent', 'sent']);
    const waiting = (await ofRule(rule.id)).find((d) => d.status === 'pending')!;
    expect(waiting).toMatchObject({ attempts: 0 });
    expect(waiting.nextAttemptAt!.getTime() - now.getTime()).toBe(60_000);
    await process(new Date(now.getTime() + 61_000));
    expect(callsTo(url('window'))).toHaveLength(3);
  });

  it('两个实例同时处理：每条只发一次（FOR UPDATE SKIP LOCKED 与通道锁）', async () => {
    const productId = await newProduct();
    const ch = await wecomChannel(t.db, owner, '并发群', { url: url('race'), rateLimitPerMin: 100 });
    const rule = await createRule(t.db, owner, productId, { name: '并发规则', eventTypes: ['requirement.created'], channelIds: [ch.id] });
    for (let i = 0; i < 6; i++) await createRequirement(t.db, owner, productId, { title: `并发 ${i}` });
    const now = later();
    await Promise.all([process(now), process(now)]);
    await process(now);
    expect(callsTo(url('race'))).toHaveLength(6);
    expect((await ofRule(rule.id)).every((d) => d.status === 'sent' && d.attempts === 1)).toBe(true);
  });

  it('租约按实际时钟计算：用较早的 now 领取的记录，在真实租约内不会被 now 更晚的另一个实例回收', async () => {
    const productId = await newProduct();
    const ch = await wecomChannel(t.db, owner, '实际时钟群', { url: url('wall-clock') });
    const rule = await createRule(t.db, owner, productId, { name: '租约规则', eventTypes: ['requirement.created'], channelIds: [ch.id] });
    await createRequirement(t.db, owner, productId, { title: '发送中的需求' });
    const [d] = await ofRule(rule.id);
    // 实例 A 本轮开始得早（now 比实际时间早 10 分钟），轮到这条时才领取
    const stale = new Date(Date.now() - 10 * 60_000);
    await t.adminDb.update(notificationDeliveries).set({ nextAttemptAt: stale }).where(eq(notificationDeliveries.id, d!.id));
    let entered!: () => void;
    const sending = new Promise<void>((r) => (entered = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: Transport = {
      ...fake.transport,
      async postJson(u, body, headers) {
        entered();
        await gate;
        return fake.transport.postJson(u, body, headers);
      },
    };
    const a = processDueDeliveries(t.db, owner.orgId, { ...deps, transport: slow }, stale);
    await sending;
    const claimed = await row(d!.id);
    expect(claimed.status).toBe('sending');
    expect(claimed.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    // 实例 B 用当前时间处理：A 的租约按实际时钟仍未到期，不回收
    await process(later());
    expect(await row(d!.id)).toMatchObject({ status: 'sending', attempts: 0 });
    release();
    expect((await a).sent).toBe(1);
    const done = await row(d!.id);
    expect(done).toMatchObject({ status: 'sent', attempts: 1 });
    expect(done.sentAt!.getTime()).toBeGreaterThan(stale.getTime() + 5 * 60_000);
    expect(callsTo(url('wall-clock'))).toHaveLength(1);
  });

  it('事件消息超过企微 markdown 单条上限：截断并注明，只发一条', async () => {
    const productId = await newProduct();
    const ch = await wecomChannel(t.db, owner, '长消息群', { url: url('long') });
    const tpl = await createMessageTemplate(t.db, owner, { name: '很长的事件模板', format: 'markdown', body: `## {{subject.key}}\n\n${'很长的变更说明。'.repeat(400)}` });
    const rule = await createRule(t.db, owner, productId, { name: '长消息规则', eventTypes: ['requirement.created'], channelIds: [ch.id], templateId: tpl.id });
    await createRequirement(t.db, owner, productId, { title: '长消息需求' });
    await process(later());
    const calls = callsTo(url('long'));
    expect(calls).toHaveLength(1);
    const content = (calls[0]!.body.markdown as { content: string }).content;
    expect(content.endsWith('…（内容过长，已截断）')).toBe(true);
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(4096);
    expect((await ofRule(rule.id))[0]).toMatchObject({ status: 'sent' });
  });

  it('通道收窄可用产品后：已排队的不再允许的产品记录放弃，不发送', async () => {
    const productId = await newProduct();
    const other = await newProduct();
    const ch = await wecomChannel(t.db, owner, '收窄群', { url: url('narrowed'), allowedProductIds: [productId, other] });
    const dropped = await createRule(t.db, owner, productId, { name: '被收窄的规则', eventTypes: ['requirement.created'], channelIds: [ch.id] });
    const kept = await createRule(t.db, owner, other, { name: '仍允许的规则', eventTypes: ['requirement.created'], channelIds: [ch.id] });
    await createRequirement(t.db, owner, productId, { title: '不再允许' });
    await createRequirement(t.db, owner, other, { title: '仍然允许' });
    await updateChannel(t.db, owner, ch.id, { allowedProductIds: [other] }, TEST_DEPS);
    await process(later());
    expect((await ofRule(dropped.id))[0]).toMatchObject({ status: 'dead', attempts: 0, nextAttemptAt: null, response: '通道不再允许本产品使用，未发送' });
    expect((await ofRule(kept.id))[0]).toMatchObject({ status: 'sent' });
    expect(callsTo(url('narrowed'))).toHaveLength(1);
  });

  it('定时推送：同一次执行全部放弃时连续失败加一并告警；下一次成功清零并记 last_success_at', async () => {
    const productId = await newProduct();
    const ch = await wecomChannel(t.db, owner, '日报群', { url: url('schedule') });
    const s = await createSchedule(t.db, owner, { productId, name: '日报', cron: '0 19 * * 1-5', source: 'overview_card', channelIds: [ch.id] });
    const run = await runScheduleNow(t.db, owner, s.id, deps);
    await t.adminDb.update(notificationDeliveries).set({ attempts: 4 }).where(eq(notificationDeliveries.runId, run.runId!));
    fake.reset(() => BAD);
    await process(later());
    const failed = (await t.adminDb.select().from(notificationSchedules).where(eq(notificationSchedules.id, s.id)))[0]!;
    expect(failed).toMatchObject({ consecutiveFailures: 1, alertState: 'alert', lastSuccessAt: null });
    expect((await listDeliveries(t.db, owner, { kind: 'schedule' })).deliveries.find((d) => d.source.id === s.id)!.source).toMatchObject({ name: '日报', alert: true });

    fake.reset(() => OK);
    const run2 = await runScheduleNow(t.db, owner, s.id, deps);
    await process(later(2000));
    const [d2] = await t.adminDb.select().from(notificationDeliveries).where(eq(notificationDeliveries.runId, run2.runId!));
    const ok = (await t.adminDb.select().from(notificationSchedules).where(eq(notificationSchedules.id, s.id)))[0]!;
    expect(ok).toMatchObject({ consecutiveFailures: 0, alertState: 'normal' });
    expect(ok.lastSuccessAt!.getTime()).toBe(d2!.createdAt.getTime());
  });

  it('变更摘要：发送成功后条目标记已消费；全部放弃时释放给下一次', async () => {
    const productId = await newProduct();
    const ch = await wecomChannel(t.db, owner, '摘要群', { url: url('digest') });
    const s = await createSchedule(t.db, owner, { productId, name: '摘要', cron: '0 18 * * *', source: 'digest', channelIds: [ch.id] });
    await createRule(t.db, owner, productId, { name: '并入摘要', eventTypes: ['requirement.state_changed'], mode: 'digest', digestScheduleId: s.id });
    const r = await createRequirement(t.db, owner, productId, { title: '摘要需求' });
    await transitionRequirement(t.db, owner, r.id, { to: 'doing' });
    const run = await runScheduleNow(t.db, owner, s.id, deps);
    await process(later());
    const items = () => t.adminDb.select().from(notificationDigestItems).where(eq(notificationDigestItems.scheduleId, s.id));
    expect((await items()).every((i) => i.consumedAt !== null && i.runId === run.runId)).toBe(true);

    await transitionRequirement(t.db, owner, r.id, { to: 'done' });
    const run2 = await runScheduleNow(t.db, owner, s.id, deps);
    await t.adminDb.update(notificationDeliveries).set({ attempts: 4 }).where(eq(notificationDeliveries.runId, run2.runId!));
    fake.reset(() => BAD);
    await process(later(2000));
    const open = (await items()).filter((i) => i.consumedAt === null);
    expect(open).toHaveLength(1);
    expect(open[0]!.runId).toBeNull();
  });

  it('渲染出错的记录在自己的 savepoint 里回滚，直接放弃并记原因，同一轮其余记录照常发送', async () => {
    const productId = await newProduct();
    const ch = await wecomChannel(t.db, owner, '渲染群', { url: url('render') });
    const rule = await createRule(t.db, owner, productId, { name: '渲染规则', eventTypes: ['requirement.created'], channelIds: [ch.id] });
    const req = await createRequirement(t.db, owner, productId, { title: '正常渲染' });
    // 迭代 id 不是合法 uuid：渲染时的查询在数据库里报错
    const [ev] = await t.adminDb
      .insert(domainEvents)
      .values({ orgId: owner.orgId, productId, type: 'requirement.iteration_changed', subjectType: 'requirement', subjectId: req.id, payload: { changes: [{ field: 'iterationId', old: 'not-a-uuid', new: null }] } })
      .returning();
    const [bad] = await t.adminDb
      .insert(notificationDeliveries)
      .values({ orgId: owner.orgId, kind: 'rule', ruleId: rule.id, channelId: ch.id, eventId: ev!.id, status: 'pending', nextAttemptAt: new Date(Date.now() - 1000) })
      .returning();
    const now = later();
    await process(now);
    const dead = await row(bad!.id);
    // 没有真正发出，attempts 保持 0
    expect(dead).toMatchObject({ status: 'dead', attempts: 0, payload: null, nextAttemptAt: null });
    expect(dead.response).toMatch(/^渲染失败：/);
    expect(dead.response).not.toMatch(/select/i);
    expect((await ofRule(rule.id)).filter((d) => d.status === 'sent')).toHaveLength(1);
    expect(callsTo(url('render'))).toHaveLength(1);
  });

  it('租约按发送顺序逐条递增；发送期间记录被回收的，结果不覆盖', async () => {
    const productId = await newProduct();
    const ch = await wecomChannel(t.db, owner, '租约群', { url: url('lease-order') });
    const rule = await createRule(t.db, owner, productId, { name: '租约规则', eventTypes: ['requirement.created'], channelIds: [ch.id] });
    for (const title of ['甲', '乙', '丙']) await createRequirement(t.db, owner, productId, { title });
    const leases: number[] = [];
    let first = true;
    const probe: Transport = {
      ...fake.transport,
      async postJson() {
        if (first) {
          first = false;
          const rows = await ofRule(rule.id);
          leases.push(...rows.map((d) => d.nextAttemptAt!.getTime()).sort((a, b) => a - b));
          // 模拟另一实例在发送期间回收了第一条
          const [firstSending] = rows.sort((a, b) => a.nextAttemptAt!.getTime() - b.nextAttemptAt!.getTime());
          await t.adminDb.update(notificationDeliveries).set({ status: 'failed', response: '已被回收' }).where(eq(notificationDeliveries.id, firstSending!.id));
        }
        return OK;
      },
    };
    const now = later();
    await processDueDeliveries(t.db, owner.orgId, { ...deps, transport: probe }, now);
    expect(leases.map((l) => l - now.getTime())).toEqual([75_000, 90_000, 105_000]);
    const rows = await ofRule(rule.id);
    expect(rows.map((d) => d.status).sort()).toEqual(['failed', 'sent', 'sent']);
    expect(rows.find((d) => d.status === 'failed')).toMatchObject({ response: '已被回收', attempts: 0 });
  });

  it('一轮领取的发送余量合计不超过 240 秒（租约不超过 5 分钟），其余留给下一轮', async () => {
    const mail = await createChannel(
      t.db,
      owner,
      { kind: 'email', name: '批量邮件', rateLimitPerMin: 100, config: { host: 'smtp.example.com', port: 465, secure: true, user: 'robot@example.com', pass: 'demo-pass', from: 'robot@example.com', to: ['pm@example.com'] } },
      TEST_DEPS,
    );
    await t.adminDb.insert(notificationDeliveries).values(
      Array.from({ length: 6 }, (_, i) => ({
        orgId: owner.orgId,
        kind: 'test' as const,
        channelId: mail.id,
        payload: { type: 'email' as const, subject: `批量 ${i}`, text: '正文' },
        status: 'pending' as const,
        nextAttemptAt: new Date(Date.now() - 1000),
      })),
    );
    const ofMail = () => t.adminDb.select().from(notificationDeliveries).where(eq(notificationDeliveries.channelId, mail.id));
    let leases: number[] = [];
    const probe: Transport = {
      ...fake.transport,
      async sendMail(cfg, msg) {
        if (leases.length === 0) leases = (await ofMail()).filter((d) => d.status === 'sending').map((d) => d.nextAttemptAt!.getTime());
        return fake.transport.sendMail(cfg, msg);
      },
    };
    const now = later();
    await processDueDeliveries(t.db, owner.orgId, { ...deps, transport: probe }, now);
    expect(fake.mails).toHaveLength(4);
    expect(Math.max(...leases) - now.getTime()).toBe(300_000);
    expect((await ofMail()).filter((d) => d.status === 'pending')).toHaveLength(2);
    await processDueDeliveries(t.db, owner.orgId, { ...deps, transport: probe }, now);
    expect(fake.mails).toHaveLength(6);
    expect((await ofMail()).every((d) => d.status === 'sent' && d.attempts === 1)).toBe(true);
  });

  it('测试消息只处理自己的记录，不回收其他实例的发送中记录', async () => {
    const other = await wecomChannel(t.db, owner, '他处群', { url: url('held') });
    const [held] = await t.adminDb
      .insert(notificationDeliveries)
      .values({ orgId: owner.orgId, kind: 'test', channelId: other.id, payload: { type: 'json', body: { msgtype: 'text', text: { content: '占用' } } }, status: 'sending', nextAttemptAt: new Date(Date.now() - 1000) })
      .returning();
    const ch = await wecomChannel(t.db, owner, '自测群', { url: url('own') });
    expect((await sendTestMessage(t.db, owner, ch.id, deps)).status).toBe('sent');
    expect(await row(held!.id)).toMatchObject({ status: 'sending', attempts: 0 });
    await t.adminDb.update(notificationDeliveries).set({ status: 'dead', nextAttemptAt: null }).where(eq(notificationDeliveries.id, held!.id));
  });

  it('租约到期仍在发送中的按一次失败处理；停用通道的记录直接放弃', async () => {
    const ch = await wecomChannel(t.db, owner, '中断群', { url: url('lease') });
    const [stuck] = await t.adminDb
      .insert(notificationDeliveries)
      .values({ orgId: owner.orgId, kind: 'test', channelId: ch.id, payload: { type: 'json', body: { msgtype: 'text', text: { content: '中断' } } }, status: 'sending', nextAttemptAt: new Date(Date.now() - 1000) })
      .returning();
    await process(new Date());
    expect(await row(stuck!.id)).toMatchObject({ status: 'dead', attempts: 1, response: '发送中断（进程退出或超时），按失败处理' });

    const productId = await newProduct();
    const off = await wecomChannel(t.db, owner, '将停用群', { url: url('disabled') });
    const rule = await createRule(t.db, owner, productId, { name: '停用规则', eventTypes: ['requirement.created'], channelIds: [off.id] });
    await createRequirement(t.db, owner, productId, { title: '发不出去' });
    await updateChannel(t.db, owner, off.id, { enabled: false }, TEST_DEPS);
    await process(later());
    expect((await ofRule(rule.id))[0]).toMatchObject({ status: 'dead', response: '通道已停用，未发送' });
    expect(callsTo(url('disabled'))).toHaveLength(0);
  });
});

describe('重发与发送记录列表', () => {
  it('重发复制为新的待发记录；迁移记录、未结束的记录不能重发；只有组织管理员', async () => {
    const ch = await wecomChannel(t.db, owner, '重发群', { url: url('resend') });
    const sent = await sendTestMessage(t.db, owner, ch.id, deps);
    const again = await resendDelivery(t.db, owner, sent.id);
    expect(again).toMatchObject({ kind: 'test', status: 'pending', attempts: 0 });
    expect((await row(again.id)).payload).toEqual((await row(sent.id)).payload);
    await expect(resendDelivery(t.db, owner, again.id)).rejects.toThrow('只能重发已发送或已放弃的记录');
    const [legacy] = await t.adminDb
      .insert(notificationDeliveries)
      .values({ orgId: owner.orgId, kind: 'test', channelId: ch.id, payload: { type: 'legacy', content: '旧日志' }, status: 'sent', attempts: 1, legacyKey: 'push_logs:1' })
      .returning();
    await expect(resendDelivery(t.db, owner, legacy!.id)).rejects.toThrow('迁移来的历史记录不能重发');
    const member = await asMember(t.db, owner, '成员庚');
    await expect(resendDelivery(t.db, member, sent.id)).rejects.toThrow('需要组织管理员权限');
  });

  it('同一事务写入、created_at 相同的记录跨页时每条恰好出现一次', async () => {
    const ch = await wecomChannel(t.db, owner, '分页群', { url: url('page') });
    const inserted = await t.adminDb
      .insert(notificationDeliveries)
      .values(Array.from({ length: 5 }, () => ({ orgId: owner.orgId, kind: 'test' as const, channelId: ch.id, payload: { type: 'json' as const, body: {} }, status: 'sent' as const, attempts: 1 })))
      .returning();
    expect(new Set(inserted.map((d) => d.createdAt.getTime())).size).toBe(1);
    const seen: string[] = [];
    let before: string | undefined;
    do {
      const page = await listDeliveries(t.db, owner, { channelId: ch.id, limit: 2, before });
      seen.push(...page.deliveries.map((d) => d.id));
      before = page.nextCursor ?? undefined;
    } while (before);
    expect(seen.sort()).toEqual(inserted.map((d) => d.id).sort());
    await expect(listDeliveries(t.db, owner, { before: 'bad|cursor' })).rejects.toThrow('分页参数无效');
  });

  it('按来源、状态、通道筛选，按时间倒序分页；不含通道配置', async () => {
    const page1 = await listDeliveries(t.db, owner, { kind: 'test', limit: 2 });
    expect(page1.deliveries).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await listDeliveries(t.db, owner, { kind: 'test', limit: 2, before: page1.nextCursor! });
    expect(page2.deliveries.some((d) => page1.deliveries.some((x) => x.id === d.id))).toBe(false);
    expect(page1.deliveries[0]!.createdAt.getTime()).toBeGreaterThanOrEqual(page2.deliveries[0]!.createdAt.getTime());
    expect((await listDeliveries(t.db, owner, { status: 'dead' })).deliveries.every((d) => d.status === 'dead')).toBe(true);
    const all = await listDeliveries(t.db, owner, { limit: 100 });
    const legacy = all.deliveries.find((d) => d.legacy)!;
    expect(legacy).toMatchObject({ preview: '旧日志', canResend: false });
    expect(JSON.stringify(all)).not.toContain('127.0.0.1');
    const ch = all.deliveries[0]!.channel.id;
    expect((await listDeliveries(t.db, owner, { channelId: ch })).deliveries.every((d) => d.channel.id === ch)).toBe(true);
  });
});
