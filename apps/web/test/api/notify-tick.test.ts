import { afterAll, describe, expect, it } from 'vitest';
import { call, initAndLogin, makeApp, sessionFrom } from './helpers';

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const c of cleanups) await c();
});

describe('手动驱动后台发送', () => {
  it('没有开启 FLOWER_NOTIFY_TICK_API 时接口不存在', async () => {
    const { app, cleanup } = await makeApp();
    cleanups.push(cleanup);
    const session = await initAndLogin(app);
    expect((await call(app, 'POST', '/instance/notifications/tick', { session, body: {} })).status).toBe(404);
  });

  it('开启后实例管理员可以驱动一轮（可传 now）；其他账号 403', async () => {
    const { app, cleanup } = await makeApp({ tickApi: true });
    cleanups.push(cleanup);
    const session = await initAndLogin(app);
    const r = await call(app, 'POST', '/instance/notifications/tick', { session, body: { now: '2026-10-12T12:00:00Z' } });
    expect(r.status).toBe(200);
    expect(r.body.summary).toEqual({ orgs: 0, schedulesRun: 0, sent: 0, failed: 0, dead: 0, rateLimited: 0 });
    const inv = await call(app, 'POST', '/orgs/acme/invitations', { session, body: { email: 'member@example.com', orgRole: 'admin' } });
    const accept = await call(app, 'POST', `/invitations/${inv.body.token}/accept`, { body: { name: '组织管理员', password: 'password123' } });
    expect((await call(app, 'POST', '/instance/notifications/tick', { session: sessionFrom(accept.res), body: {} })).status).toBe(403);
  });
});
