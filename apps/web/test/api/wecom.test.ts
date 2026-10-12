import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '@/server/api';
import { startFakeWecom } from '../fake-wecom';
import { call, initAndLogin, makeApp, sessionFrom } from './helpers';

const SECRET = 'app-secret-demo-0001';
let app: App;
let cleanup: () => Promise<void>;
let wecom: Awaited<ReturnType<typeof startFakeWecom>>;
let session: string;
let zhang: { session: string; id: string };
let liId: string;

beforeAll(async () => {
  wecom = await startFakeWecom({ secret: SECRET, users: { 'code-zhang': 'zhangsan' } });
  ({ app, cleanup } = await makeApp({ wecomApiBase: wecom.base }));
  session = await initAndLogin(app);
  const inv = await call(app, 'POST', '/orgs/acme/invitations', { session, body: { email: 'zhang@example.com', orgRole: 'member' } });
  const s = sessionFrom((await call(app, 'POST', `/invitations/${inv.body.token}/accept`, { body: { name: '张三', password: 'password123' } })).res);
  zhang = { session: s, id: (await call(app, 'GET', '/orgs/acme', { session: s })).body.me.memberId };
  liId = (await call(app, 'POST', '/orgs/acme/members', { session, body: { displayName: '李四', email: 'li@example.com' } })).body.member.id;
});
afterAll(async () => {
  await wecom.close();
  await cleanup();
});

describe('成员企业微信账号', () => {
  it('组织管理员填写；重复 409 带姓名；格式不对 400；普通成员 403', async () => {
    expect((await call(app, 'PUT', `/orgs/acme/members/${liId}/wecom`, { session, body: { userid: 'lisi' } })).body.member).toEqual({ memberId: liId, wecomUserid: 'lisi' });
    const members = (await call(app, 'GET', '/orgs/acme/members', { session })).body.members;
    expect(members.find((m: { id: string }) => m.id === liId).wecomUserid).toBe('lisi');
    const dup = await call(app, 'PUT', `/orgs/acme/members/${zhang.id}/wecom`, { session, body: { userid: 'lisi' } });
    expect(dup.status).toBe(409);
    expect(dup.body.error.message).toBe('该企业微信账号已绑定到 李四');
    expect((await call(app, 'PUT', `/orgs/acme/members/${zhang.id}/wecom`, { session, body: { userid: 'a b' } })).status).toBe(400);
    expect((await call(app, 'PUT', `/orgs/acme/members/${liId}/wecom`, { session: zhang.session, body: { userid: null } })).status).toBe(403);
  });

  it('CSV 预览不写入、确认导入只写可匹配的行；普通成员 403；过大 400', async () => {
    const csv = '邮箱,企业微信账号\nzhang@example.com,zhangsan\nnobody@example.com,x';
    const preview = await call(app, 'POST', '/orgs/acme/wecom-import/preview', { session, body: { csv } });
    expect(preview.body.result.counts).toEqual({ ok: 1, unchanged: 0, not_found: 1, duplicate: 0, invalid: 0 });
    expect(preview.body.result.applied).toBe(0);
    expect((await call(app, 'POST', '/orgs/acme/wecom-import', { session, body: { csv } })).body.result.applied).toBe(1);
    expect((await call(app, 'POST', '/orgs/acme/wecom-import/preview', { session: zhang.session, body: { csv } })).status).toBe(403);
    expect((await call(app, 'POST', '/orgs/acme/wecom-import/preview', { session, body: { csv: 'x'.repeat(200_001) } })).status).toBe(400);
    await call(app, 'PUT', `/orgs/acme/members/${zhang.id}/wecom`, { session, body: { userid: null } });
  });
});

describe('企业微信应用与扫码绑定', () => {
  it('应用配置只返回脱敏提示与回调地址；任何响应里都没有密钥；普通成员 403', async () => {
    const empty = await call(app, 'GET', '/orgs/acme/wecom-app', { session });
    expect(empty.body.settings).toEqual({ app: null, callbackUrl: 'http://localhost:3000/api/v1/orgs/acme/wecom/callback', callbackDomain: 'localhost:3000' });
    expect((await call(app, 'PUT', '/orgs/acme/wecom-app', { session, body: { corpId: 'ww0001', agentId: '1000002', bindEnabled: true } })).status).toBe(400);
    const saved = await call(app, 'PUT', '/orgs/acme/wecom-app', { session, body: { corpId: 'ww0001', agentId: '1000002', secret: SECRET, bindEnabled: true } });
    expect(saved.body.settings.app).toMatchObject({ corpId: 'ww0001', agentId: '1000002', secretHint: '****0001', bindEnabled: true });
    const again = await call(app, 'GET', '/orgs/acme/wecom-app', { session });
    for (const r of [saved, again]) expect(JSON.stringify(r.body)).not.toContain(SECRET);
    expect((await call(app, 'GET', '/orgs/acme/wecom-app', { session: zhang.session })).status).toBe(403);
  });

  it('扫码绑定：发起返回扫码页地址；回调成功跳回个人设置；重放显示原因；只访问假企业微信；可以自行解除', async () => {
    const start = await call(app, 'POST', '/orgs/acme/me/wecom/bind', { session: zhang.session });
    const state = new URL(start.body.url).searchParams.get('state')!;
    expect(new URL(start.body.url).host).toBe('login.work.weixin.qq.com');
    expect(JSON.stringify(start.body)).not.toContain(SECRET);
    const cb = await call(app, 'GET', `/orgs/acme/wecom/callback?code=code-zhang&state=${encodeURIComponent(state)}`, { session: zhang.session });
    expect(cb.status).toBe(302);
    expect(cb.res.headers.get('location')).toBe('/settings?org=acme&wecom=bound');
    expect(cb.res.headers.get('location')).not.toContain(SECRET);
    expect(wecom.calls).toEqual(['/cgi-bin/gettoken', '/cgi-bin/auth/getuserinfo']);
    const settings = await call(app, 'GET', '/orgs/acme/me/notification-settings', { session: zhang.session });
    expect(settings.body.settings.wecom).toMatchObject({ userid: 'zhangsan', bindEnabled: true });
    const replay = await call(app, 'GET', `/orgs/acme/wecom/callback?code=code-zhang&state=${encodeURIComponent(state)}`, { session: zhang.session });
    const loc = new URL(replay.res.headers.get('location')!, 'http://localhost');
    expect(loc.pathname).toBe('/settings');
    expect(loc.searchParams.get('wecom_error')).toBe('绑定链接无效或已使用，请重新扫码');
    expect(replay.res.headers.get('location')).not.toContain(SECRET);
    expect(JSON.stringify(settings.body)).not.toContain(SECRET);
    expect((await call(app, 'DELETE', '/orgs/acme/me/wecom', { session: zhang.session })).status).toBe(204);
    expect((await call(app, 'GET', '/orgs/acme/me/notification-settings', { session: zhang.session })).body.settings.wecom.userid).toBeNull();
  });

  it('API Token 不能发起绑定', async () => {
    const me = (await call(app, 'GET', '/orgs/acme', { session })).body.me.memberId;
    const token = (await call(app, 'POST', '/orgs/acme/tokens', { session, body: { memberId: me, name: '写', scope: { products: 'all', access: 'write' } } })).body.token;
    expect((await call(app, 'POST', '/orgs/acme/me/wecom/bind', { token })).status).toBe(403);
  });

  it('回调里的组织不是当前登录账号所属的组织、未登录或用 Token 访问：跳回个人设置并显示原因，不访问企业微信', async () => {
    const before = wecom.calls.length;
    const token = (await call(app, 'POST', '/orgs/acme/tokens', { session, body: { memberId: zhang.id, name: '写', scope: { products: 'all', access: 'write' } } })).body.token;
    const attempts = [
      call(app, 'GET', '/orgs/other-org/wecom/callback?code=code-zhang&state=x', { session: zhang.session }),
      call(app, 'GET', '/orgs/acme/wecom/callback?code=code-zhang&state=x', {}),
      call(app, 'GET', '/orgs/acme/wecom/callback?code=code-zhang&state=x', { token }),
    ];
    for (const r of await Promise.all(attempts)) {
      expect(r.status).toBe(302);
      const loc = new URL(r.res.headers.get('location')!, 'http://localhost');
      expect(loc.pathname).toBe('/settings');
      expect(loc.searchParams.get('wecom_error')).toBe('请先登录，并使用该组织的成员账号完成绑定');
      expect(loc.searchParams.has('org')).toBe(false);
      expect(loc.toString()).not.toContain(SECRET);
    }
    expect(wecom.calls.length).toBe(before);
  });
});
