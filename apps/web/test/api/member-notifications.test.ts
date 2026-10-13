import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '@/server/api';
import { startFakeWebhook } from '../fake-webhook';
import { call, initAndLogin, makeApp, sessionFrom } from './helpers';

let app: App;
let cleanup: () => Promise<void>;
let hook: Awaited<ReturnType<typeof startFakeWebhook>>;
let session: string;
let zhang: { session: string; id: string };
let guest: { session: string; id: string };
let readToken: string;
let productId: string;
let reqId: string;

const tick = () => call(app, 'POST', '/instance/notifications/tick', { session, body: {} });
const mention = (id: string, name: string) => `[@${name}](member:${id})`;

beforeAll(async () => {
  hook = await startFakeWebhook();
  ({ app, cleanup } = await makeApp({ tickApi: true }));
  session = await initAndLogin(app);
  productId = (await call(app, 'POST', '/orgs/acme/products', { session, body: { name: '网盘', key: 'PAN' } })).body.product.id;
  const join = async (email: string, name: string, orgRole: 'member' | 'guest') => {
    const inv = await call(app, 'POST', '/orgs/acme/invitations', { session, body: { email, orgRole } });
    const s = sessionFrom((await call(app, 'POST', `/invitations/${inv.body.token}/accept`, { body: { name, password: 'password123' } })).res);
    return { session: s, id: (await call(app, 'GET', '/orgs/acme', { session: s })).body.me.memberId as string };
  };
  zhang = await join('zhang@example.com', '张三', 'member');
  guest = await join('guest@example.com', '访客', 'guest');
  const me = (await call(app, 'GET', '/orgs/acme', { session })).body.me.memberId;
  readToken = (await call(app, 'POST', '/orgs/acme/tokens', { session, body: { memberId: me, name: '只读', scope: { products: 'all', access: 'read' } } })).body.token;
  reqId = (await call(app, 'POST', `/orgs/acme/products/${productId}/requirements`, { session, body: { title: '登录页改版' } })).body.requirement.id;
  await tick();
});
afterAll(async () => {
  await hook.close();
  await cleanup();
});

describe('站内通知接口', () => {
  it('被 @ 的成员能列出、计数与标已读；看不到产品的访客收不到；只读 Token 能看不能标', async () => {
    await call(app, 'POST', `/orgs/acme/requirements/${reqId}/comments`, { session, body: { body: `${mention(zhang.id, '张三')} ${mention(guest.id, '访客')} 请看` } });
    expect((await tick()).body.summary.notified).toBe(1);
    const list = await call(app, 'GET', '/orgs/acme/notifications', { session: zhang.session });
    expect(list.body.notifications).toEqual([
      expect.objectContaining({ kind: 'mentioned', body: '在评论中 @ 了你', title: 'PAN-1 登录页改版', url: '/acme/requirements/PAN-1', actor: expect.objectContaining({ displayName: 'Owner' }), readAt: null }),
    ]);
    expect((await call(app, 'GET', '/orgs/acme/notifications/unread-count', { session: zhang.session })).body).toEqual({ count: 1 });
    expect((await call(app, 'GET', '/orgs/acme/notifications', { session: guest.session })).body.notifications).toEqual([]);
    expect((await call(app, 'GET', '/orgs/acme/notifications?filter=bad', { session: zhang.session })).status).toBe(400);
    expect((await call(app, 'GET', '/orgs/acme/notifications', { token: readToken })).status).toBe(200);
    expect((await call(app, 'POST', '/orgs/acme/notifications/read-all', { token: readToken })).status).toBe(403);
    expect((await call(app, 'POST', '/orgs/acme/notifications/not-a-uuid/read', { session: zhang.session })).status).toBe(400);
    expect((await call(app, 'POST', `/orgs/acme/notifications/${list.body.notifications[0].id}/read`, { session })).status).toBe(404);
    expect((await call(app, 'POST', `/orgs/acme/notifications/${list.body.notifications[0].id}/read`, { session: zhang.session })).status).toBe(204);
    expect((await call(app, 'GET', '/orgs/acme/notifications/unread-count', { session: zhang.session })).body).toEqual({ count: 0 });
    expect((await call(app, 'POST', '/orgs/acme/notifications/read-subject', { session: zhang.session, body: { subjectType: 'requirement', subjectId: reqId } })).body).toEqual({ count: 0 });
  });

  it('关注：查询与切换；只读 Token 不能改；访客看不到产品；只能关注需求或 PRD', async () => {
    const path = `/orgs/acme/subscriptions/requirement/${reqId}`;
    expect((await call(app, 'GET', path, { session: zhang.session })).body.subscription).toEqual({ following: true, source: 'auto', reason: '你曾负责、被分配、评论或被 @' });
    expect((await call(app, 'PUT', path, { session: zhang.session, body: { following: false } })).body.subscription.following).toBe(false);
    expect((await call(app, 'PUT', path, { token: readToken, body: { following: true } })).status).toBe(403);
    expect((await call(app, 'GET', path, { session: guest.session })).status).toBe(404);
    expect((await call(app, 'GET', `/orgs/acme/subscriptions/task/${reqId}`, { session: zhang.session })).status).toBe(400);
  });

  it('通知偏好：读取与修改；普通成员不能设置系统告警；只读 Token 不能改', async () => {
    const s = await call(app, 'GET', '/orgs/acme/me/notification-settings', { session: zhang.session });
    expect(s.body.settings.prefs.map((p: { kind: string }) => p.kind)).toEqual(['mentioned', 'assigned', 'followed_change', 'signoff_due']);
    const put = await call(app, 'PUT', '/orgs/acme/me/notification-prefs/assigned', { session: zhang.session, body: { inApp: false, wecom: true, email: false } });
    expect(put.body.settings.prefs[1]).toEqual({ kind: 'assigned', inApp: false, wecom: true, email: false });
    expect((await call(app, 'PUT', '/orgs/acme/me/notification-prefs/system_alert', { session: zhang.session, body: { inApp: false, wecom: false, email: false } })).status).toBe(400);
    expect((await call(app, 'PUT', '/orgs/acme/me/notification-prefs/bad', { session: zhang.session, body: { inApp: false, wecom: false, email: false } })).status).toBe(400);
    expect((await call(app, 'PUT', '/orgs/acme/me/notification-prefs/mentioned', { token: readToken, body: { inApp: false, wecom: false, email: false } })).status).toBe(403);
  });

  it('@ 候选成员：能看到产品的人可以调用；访客没有该产品时 404', async () => {
    const r = await call(app, 'GET', `/orgs/acme/products/${productId}/mention-members`, { session: zhang.session });
    expect(r.body.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: zhang.id, displayName: '张三', canSeeProduct: true, wecomBound: false }),
        expect.objectContaining({ id: guest.id, canSeeProduct: false }),
      ]),
    );
    expect((await call(app, 'GET', `/orgs/acme/products/${productId}/mention-members`, { session: guest.session })).status).toBe(404);
  });

  it('个人提醒：产品指定个人提醒通道、成员有企业微信账号时，被指派的成员在群里被 @；权限与校验', async () => {
    const channelId = (await call(app, 'POST', '/orgs/acme/notification-channels', { session, body: { kind: 'wecom_robot', name: '研发群', config: { url: hook.url('personal-0001') } } })).body.channel.id;
    const path = `/orgs/acme/products/${productId}/personal-channel`;
    expect((await call(app, 'PUT', path, { session: zhang.session, body: { channelId } })).status).toBe(403);
    expect((await call(app, 'PUT', path, { session, body: { channelId } })).body).toEqual({ channelId });
    expect((await call(app, 'GET', path, { session })).body).toEqual({ channelId });
    expect((await call(app, 'PUT', `/orgs/acme/members/${zhang.id}/wecom`, { session, body: { userid: 'zhangsan' } })).status).toBe(200);
    const before = hook.received.length;
    await call(app, 'PATCH', `/orgs/acme/requirements/${reqId}`, { session, body: { ownerMemberId: zhang.id } });
    expect((await tick()).body.summary.sent).toBe(1);
    expect(hook.received.length).toBe(before + 1);
    expect(hook.received.at(-1)!.body).toEqual({
      msgtype: 'markdown',
      markdown: { content: '<@zhangsan> Owner 把你设为需求负责人：[PAN-1 登录页改版](http://localhost:3000/acme/requirements/PAN-1)' },
    });
    expect((await call(app, 'GET', '/orgs/acme/personal-email-channel', { session: zhang.session })).status).toBe(403);
    expect((await call(app, 'PUT', '/orgs/acme/personal-email-channel', { session, body: { channelId } })).status).toBe(400);
    expect((await call(app, 'PUT', '/orgs/acme/personal-email-channel', { session, body: { channelId: null } })).body).toEqual({ channelId: null });
  });

  it('产品管理员（非组织管理员）能设置本产品的个人提醒通道，普通成员 403', async () => {
    const channelId = (await call(app, 'POST', '/orgs/acme/notification-channels', { session, body: { kind: 'wecom_robot', name: '产品群', config: { url: hook.url('personal-0002') } } })).body.channel.id;
    const inv = await call(app, 'POST', '/orgs/acme/invitations', { session, body: { email: 'wang@example.com', orgRole: 'member' } });
    const wangSession = sessionFrom((await call(app, 'POST', `/invitations/${inv.body.token}/accept`, { body: { name: '王五', password: 'password123' } })).res);
    const wangId = (await call(app, 'GET', '/orgs/acme', { session: wangSession })).body.me.memberId as string;
    const path = `/orgs/acme/products/${productId}/personal-channel`;
    expect((await call(app, 'PUT', path, { session: wangSession, body: { channelId } })).status).toBe(403);
    expect((await call(app, 'PUT', `/orgs/acme/products/${productId}/roles/${wangId}`, { session, body: { role: 'admin' } })).status).toBe(204);
    expect((await call(app, 'PUT', path, { session: wangSession, body: { channelId } })).body).toEqual({ channelId });
    expect((await call(app, 'GET', path, { session: wangSession })).body).toEqual({ channelId });
    expect((await call(app, 'PUT', path, { session: zhang.session, body: { channelId: null } })).status).toBe(403);
  });
});
