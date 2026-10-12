import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { domainEvents, organizations, products, wecomApps } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import type { Actor } from '../src/domain-types';
import { getNotificationSettings, kindsForRole, prefsForTx, setNotificationPref } from '../src/member-notifications/prefs';
import { DEFAULT_NOTIFICATION_PREFS } from '../src/notifications/constants';
import { createChannel } from '../src/notifications/channels';
import { createProduct } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, readOnlyToken, seedInstance } from './factories';
import { TEST_DEPS, wecomChannel } from './notify-helpers';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let a: Actor;
let productId: string;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  productId = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  a = await asMember(t.db, owner, '张三');
});
afterAll(() => t.cleanup());

describe('个人通知偏好', () => {
  it('系统告警只对组织管理员', () => {
    expect(kindsForRole('owner')).toContain('system_alert');
    expect(kindsForRole('admin')).toContain('system_alert');
    expect(kindsForRole('member')).not.toContain('system_alert');
    expect(kindsForRole('guest')).toEqual(['mentioned', 'assigned', 'followed_change', 'signoff_due']);
  });

  it('没有设置时取默认；企微未绑定、没有个人提醒通道、没有邮件通道', async () => {
    const s = await getNotificationSettings(t.db, a);
    expect(s.prefs.map((p) => p.kind)).toEqual(['mentioned', 'assigned', 'followed_change', 'signoff_due']);
    expect(s.prefs[0]).toEqual({ kind: 'mentioned', ...DEFAULT_NOTIFICATION_PREFS.mentioned });
    expect(s.wecom).toEqual({ userid: null, bindEnabled: false, productChannels: 0 });
    expect(s.email).toEqual({ address: null, channelConfigured: false });
  });

  it('修改一类并记事件；批量读取时其他人仍为默认', async () => {
    const s = await setNotificationPref(t.db, a, 'assigned', { inApp: false, wecom: true, email: true });
    expect(s.prefs.find((p) => p.kind === 'assigned')).toEqual({ kind: 'assigned', inApp: false, wecom: true, email: true });
    const map = await withOrg(t.db, owner.orgId, (tx) => prefsForTx(tx, [a.memberId, owner.memberId]));
    expect(map.get(a.memberId)!.assigned).toEqual({ inApp: false, wecom: true, email: true });
    expect(map.get(owner.memberId)!.assigned).toEqual(DEFAULT_NOTIFICATION_PREFS.assigned);
    const [ev] = await t.adminDb.select().from(domainEvents).where(eq(domainEvents.type, 'member.notification_pref_set'));
    expect(ev!.payload).toMatchObject({ kind: 'assigned', changes: [{ field: 'inApp', old: true, new: false }, { field: 'email', old: false, new: true }] });
  });

  it('普通成员不能设置系统告警；只读 Token 不能修改', async () => {
    await expect(setNotificationPref(t.db, a, 'system_alert', { inApp: false, wecom: false, email: false })).rejects.toThrow('只有组织管理员接收系统告警');
    await expect(setNotificationPref(t.db, readOnlyToken(owner), 'mentioned', { inApp: false, wecom: false, email: false })).rejects.toThrow('只读 Token 不能修改通知偏好');
    expect((await setNotificationPref(t.db, owner, 'system_alert', { inApp: true, wecom: false, email: true })).prefs.at(-1)).toEqual({ kind: 'system_alert', inApp: true, wecom: false, email: true });
  });

  it('扫码绑定开关、产品个人提醒通道与组织邮件通道反映在设置里', async () => {
    const ch = await wecomChannel(t.db, owner, '研发群');
    await t.adminDb.update(products).set({ personalChannelId: ch.id }).where(eq(products.id, productId));
    const mail = await createChannel(
      t.db,
      owner,
      { kind: 'email', name: '个人通知邮件', config: { host: 'smtp.example.com', port: 465, secure: true, user: 'robot@example.com', pass: 'demo-pass', from: 'robot@example.com', to: ['pm@example.com'] } },
      TEST_DEPS,
    );
    await t.adminDb.update(organizations).set({ personalEmailChannelId: mail.id }).where(eq(organizations.id, owner.orgId));
    await t.adminDb.insert(wecomApps).values({ orgId: owner.orgId, corpId: 'ww0001', agentId: '1000002', secret: 'v1:a:b:c', secretHint: '****0001', bindEnabled: true });
    const s = await getNotificationSettings(t.db, owner);
    expect(s.wecom).toEqual({ userid: null, bindEnabled: true, productChannels: 1 });
    expect(s.email).toEqual({ address: 'owner@example.com', channelConfigured: true });
  });
});
