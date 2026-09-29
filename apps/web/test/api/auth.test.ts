import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '@/server/api';
import { call, initAndLogin, makeApp, sessionFrom } from './helpers';

let app: App;
let cleanup: () => Promise<void>;
let session: string;
beforeAll(async () => {
  ({ app, cleanup } = await makeApp());
});
afterAll(() => cleanup());

describe('初始化与登录', () => {
  it('初始化前状态', async () => {
    const r = await call(app, 'GET', '/setup/status');
    expect(r.body).toEqual({ initialized: false, allowSignup: false, allowOrgCreation: false });
  });

  it('参数错误返回 400 与明细', async () => {
    const r = await call(app, 'POST', '/setup', { body: { admin: {} } });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('invalid');
    expect(Array.isArray(r.body.error.details)).toBe(true);
  });

  it('初始化后自动登录，/me 返回账号与组织', async () => {
    session = await initAndLogin(app);
    const me = await call(app, 'GET', '/me', { session });
    expect(me.status).toBe(200);
    expect(me.body.account).toMatchObject({ email: 'owner@example.com', isInstanceAdmin: true });
    expect(me.body.orgs.map((o: { slug: string }) => o.slug)).toEqual(['acme']);
  });

  it('不能重复初始化', async () => {
    const r = await call(app, 'POST', '/setup', {
      body: { admin: { email: 'x@example.com', name: 'X', password: 'password123' }, org: { name: 'X', slug: 'x' } },
    });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('already_initialized');
  });

  it('登录、注销', async () => {
    const bad = await call(app, 'POST', '/auth/login', { body: { email: 'owner@example.com', password: 'wrong-password' } });
    expect(bad.status).toBe(401);
    expect(bad.body.error.message).toBe('邮箱或密码错误');

    const ok = await call(app, 'POST', '/auth/login', { body: { email: 'owner@example.com', password: 'password123' } });
    expect(ok.status).toBe(200);
    const s = sessionFrom(ok.res);
    expect((await call(app, 'POST', '/auth/logout', { session: s })).status).toBe(204);
    expect((await call(app, 'GET', '/me', { session: s })).status).toBe(401);
  });

  it('修改资料与密码', async () => {
    const p = await call(app, 'PATCH', '/me', { session, body: { name: '主人', preferences: { theme: 'light' } } });
    expect(p.body.account).toMatchObject({ name: '主人', preferences: { theme: 'light' } });
    const pw = await call(app, 'POST', '/me/password', { session, body: { currentPassword: 'password123', newPassword: 'password456' } });
    expect(pw.status).toBe(204);
  });

  it('默认邀请制；实例管理员开放注册后可注册', async () => {
    const denied = await call(app, 'POST', '/auth/register', { body: { email: 'a@example.com', name: 'A', password: 'password123' } });
    expect(denied.status).toBe(403);
    const settings = await call(app, 'PATCH', '/instance/settings', { session, body: { allowSignup: true } });
    expect(settings.body.allowSignup).toBe(true);
    const ok = await call(app, 'POST', '/auth/register', { body: { email: 'a@example.com', name: 'A', password: 'password123' } });
    expect(ok.status).toBe(201);
    const aSession = sessionFrom(ok.res);
    expect((await call(app, 'GET', '/instance/settings', { session: aSession })).status).toBe(403);
  });

  it('未知接口返回 404 JSON', async () => {
    const r = await call(app, 'GET', '/nope');
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('not_found');
  });

  it('登录邮箱过长返回 400 而非 500', async () => {
    const r = await call(app, 'POST', '/auth/login', { body: { email: `${'a'.repeat(3000)}@example.com`, password: 'password123' } });
    expect(r.status).toBe(400);
  });

  it('登录被限流时返回 429', async () => {
    for (let i = 0; i < 5; i++) {
      await call(app, 'POST', '/auth/login', { body: { email: 'owner@example.com', password: 'bad-password' } });
    }
    const r = await call(app, 'POST', '/auth/login', { body: { email: 'owner@example.com', password: 'password456' } });
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe('rate_limited');
  });
});
