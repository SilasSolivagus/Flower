import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '@/server/api';
import { startFakeWebhook } from '../fake-webhook';
import { call, initAndLogin, makeApp, sessionFrom } from './helpers';

let app: App;
let cleanup: () => Promise<void>;
let hook: Awaited<ReturnType<typeof startFakeWebhook>>;
let session: string;
let editorSession: string;
let readToken: string;
let writeToken: string;
let productId: string;
let channelId: string;

beforeAll(async () => {
  hook = await startFakeWebhook();
  ({ app, cleanup } = await makeApp({ tickApi: true }));
  session = await initAndLogin(app);
  productId = (await call(app, 'POST', '/orgs/acme/products', { session, body: { name: '网盘', key: 'PAN' } })).body.product.id;
  const inv = await call(app, 'POST', '/orgs/acme/invitations', { session, body: { email: 'editor@example.com', orgRole: 'member' } });
  editorSession = sessionFrom((await call(app, 'POST', `/invitations/${inv.body.token}/accept`, { body: { name: '编辑', password: 'password123' } })).res);
  const me = (await call(app, 'GET', '/orgs/acme', { session })).body.me.memberId;
  const issue = (access: 'read' | 'write') => call(app, 'POST', '/orgs/acme/tokens', { session, body: { memberId: me, name: access, scope: { products: 'all', access } } });
  readToken = (await issue('read')).body.token;
  writeToken = (await issue('write')).body.token;
});
afterAll(async () => {
  await hook.close();
  await cleanup();
});

describe('推送接口', () => {
  it('通道：登记、测试消息发到本机假接收端；任何响应里都没有明文配置', async () => {
    const created = await call(app, 'POST', '/orgs/acme/notification-channels', { session, body: { kind: 'wecom_robot', name: '研发群', config: { url: hook.url('api-demo-0001') } } });
    expect(created.status).toBe(201);
    expect(created.body.channel).toMatchObject({ name: '研发群', configHint: '…/send?key=****0001', rateLimitPerMin: 20 });
    channelId = created.body.channel.id;
    const test = await call(app, 'POST', `/orgs/acme/notification-channels/${channelId}/test`, { session });
    expect(test.body.delivery).toMatchObject({ kind: 'test', status: 'sent', attempts: 1 });
    expect(hook.received.at(-1)!.body).toMatchObject({ msgtype: 'text' });
    const list = await call(app, 'GET', '/orgs/acme/notification-channels', { session });
    const deliveries = await call(app, 'GET', '/orgs/acme/notification-deliveries', { session });
    for (const r of [created, test, list, deliveries]) expect(JSON.stringify(r.body)).not.toContain('api-demo-0001');
    expect((await call(app, 'PATCH', `/orgs/acme/notification-channels/${channelId}`, { session, body: { config: { url: 'ftp://x.example.com' } } })).status).toBe(400);
    expect((await call(app, 'POST', '/orgs/acme/notification-channels', { session, body: { kind: 'sms', name: 'x', config: {} } })).status).toBe(400);
  });

  it('权限：编辑与只读 Token 不能管理通道、规则、定时推送与发送记录；成员可以读模板', async () => {
    const rule = { name: 'x', eventTypes: ['requirement.created'], channelIds: [channelId] };
    const schedule = { productId, name: 'x', cron: '0 9 * * *', source: 'overview_card', channelIds: [channelId] };
    const checks: Array<[string, string, { session?: string; token?: string; body?: unknown }]> = [
      ['GET', '/orgs/acme/notification-channels', { session: editorSession }],
      ['GET', '/orgs/acme/notification-channels', { token: readToken }],
      ['POST', '/orgs/acme/notification-channels', { token: readToken, body: { kind: 'wecom_robot', name: 'x', config: { url: hook.url('x') } } }],
      ['POST', `/orgs/acme/notification-channels/${channelId}/test`, { session: editorSession }],
      ['GET', `/orgs/acme/products/${productId}/notification-channels`, { session: editorSession }],
      ['POST', `/orgs/acme/products/${productId}/notification-rules`, { session: editorSession, body: rule }],
      ['POST', `/orgs/acme/products/${productId}/notification-rules`, { token: readToken, body: rule }],
      ['POST', '/orgs/acme/notification-schedules', { token: readToken, body: schedule }],
      ['GET', `/orgs/acme/notification-schedules?product=${productId}`, { session: editorSession }],
      ['GET', '/orgs/acme/notification-deliveries', { session: editorSession }],
      ['POST', '/orgs/acme/message-templates', { session: editorSession, body: { name: 'x', format: 'text', body: 'x' } }],
    ];
    for (const [method, path, opts] of checks) expect((await call(app, method, path, opts)).status, `${method} ${path}`).toBe(403);
    expect((await call(app, 'GET', '/orgs/acme/message-templates', { session: editorSession })).status).toBe(200);
  });

  it('规则、定时推送、立即执行（Token 需要写权限）、驱动发送、发送记录、重发、停用与删除', async () => {
    const rule = await call(app, 'POST', `/orgs/acme/products/${productId}/notification-rules`, { session, body: { name: '新需求', eventTypes: ['requirement.created'], channelIds: [channelId] } });
    expect(rule.status).toBe(201);
    expect((await call(app, 'GET', `/orgs/acme/products/${productId}/notification-rules`, { session })).body.rules).toHaveLength(1);
    await call(app, 'POST', `/orgs/acme/products/${productId}/requirements`, { session, body: { title: '接口需求' } });
    const created = await call(app, 'POST', '/orgs/acme/notification-schedules', { session, body: { productId, name: '日报', cron: '0 19 * * 1-5', source: 'overview_card', channelIds: [channelId] } });
    expect(created.status).toBe(201);
    const scheduleId = created.body.schedule.id;
    expect(created.body.schedule.nextRunAt).not.toBeNull();
    expect((await call(app, 'POST', `/orgs/acme/notification-schedules/${scheduleId}/run`, { token: readToken })).status).toBe(403);
    const run = await call(app, 'POST', `/orgs/acme/notification-schedules/${scheduleId}/run`, { token: writeToken });
    expect(run.body.result).toMatchObject({ deliveries: 1, skipped: null });
    const before = hook.received.length;
    const tick = await call(app, 'POST', '/instance/notifications/tick', { session, body: {} });
    expect(tick.body.summary).toMatchObject({ sent: 2 });
    expect(hook.received.length - before).toBe(2);
    const list = await call(app, 'GET', '/orgs/acme/notification-deliveries?kind=schedule', { session });
    expect(list.body.deliveries[0]).toMatchObject({ status: 'sent', source: { type: 'schedule', name: '日报' }, channel: { name: '研发群' } });
    const resend = await call(app, 'POST', `/orgs/acme/notification-deliveries/${list.body.deliveries[0].id}/resend`, { session });
    expect(resend.status).toBe(201);
    expect(resend.body.delivery.status).toBe('pending');
    expect((await call(app, 'GET', '/orgs/acme/notification-deliveries?status=bogus', { session })).status).toBe(400);
    expect((await call(app, 'GET', '/orgs/acme/notification-schedules', { session })).body.schedules).toHaveLength(1);
    expect((await call(app, 'PATCH', `/orgs/acme/notification-schedules/${scheduleId}`, { session, body: { enabled: false } })).body.schedule.nextRunAt).toBeNull();
    expect((await call(app, 'PATCH', `/orgs/acme/notification-rules/${rule.body.rule.id}`, { session, body: { enabled: false } })).body.rule.enabled).toBe(false);
    expect((await call(app, 'DELETE', `/orgs/acme/notification-rules/${rule.body.rule.id}`, { session })).status).toBe(409);
    expect((await call(app, 'DELETE', `/orgs/acme/notification-channels/${channelId}`, { session })).status).toBe(409);
  });

  it('模板：列表含四个预置模板；语法错误 400', async () => {
    const list = await call(app, 'GET', '/orgs/acme/message-templates', { session });
    expect(list.body.templates.filter((x: { builtin: boolean }) => x.builtin)).toHaveLength(4);
    const bad = await call(app, 'POST', '/orgs/acme/message-templates', { session, body: { name: '坏', format: 'markdown', body: '{{#a}}' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toContain('模板语法错误');
  });

  it('畸形 id 返回 400', async () => {
    expect((await call(app, 'POST', '/orgs/acme/notification-channels/not-a-uuid/test', { session })).status).toBe(400);
    expect((await call(app, 'POST', '/orgs/acme/notification-schedules/not-a-uuid/run', { session })).status).toBe(400);
    expect((await call(app, 'GET', '/orgs/acme/notification-schedules?product=not-a-uuid', { session })).status).toBe(400);
  });
});
