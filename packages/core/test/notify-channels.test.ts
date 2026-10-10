import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { domainEvents, notificationChannels, notificationSchedules } from '../src/db/schema';
import type { Actor } from '../src/domain-types';
import { createChannel, deleteChannel, listChannels, listProductChannelOptions, updateChannel } from '../src/notifications/channels';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, readOnlyToken, seedInstance } from './factories';
import { TEST_DEPS, WECOM_URL, wecomChannel } from './notify-helpers';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let productId: string;
let otherProductId: string;
const EMAIL = { host: 'smtp.example.com', port: 465, secure: true, user: 'robot@example.com', pass: 'demo-password-1', from: 'robot@example.com', to: ['pm@example.com', 'dev@example.com'] };

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  productId = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  otherProductId = (await createProduct(t.db, owner, { name: '相册', key: 'PIC' })).id;
});
afterAll(() => t.cleanup());

describe('通道', () => {
  it('登记企微通道：返回脱敏提示与默认值；库里是密文；事件里没有明文', async () => {
    const ch = await createChannel(t.db, owner, { kind: 'wecom_robot', name: '研发群', groupLabel: '研发', config: { url: WECOM_URL } }, TEST_DEPS);
    expect(ch).toMatchObject({
      kind: 'wecom_robot',
      name: '研发群',
      groupLabel: '研发',
      configHint: '…/send?key=****0001',
      rateLimitPerMin: 20,
      enabled: true,
      allowedProductIds: [],
      settings: null,
      usage: { rules: 0, schedules: 0, deliveries: 0 },
    });
    expect(JSON.stringify(ch)).not.toContain('demo-key');
    const [row] = await t.adminDb.select().from(notificationChannels).where(eq(notificationChannels.id, ch.id));
    expect(row!.config.startsWith('v1:')).toBe(true);
    const events = await t.adminDb.select().from(domainEvents).where(eq(domainEvents.subjectId, ch.id));
    expect(events.map((e) => e.type)).toEqual(['notification_channel.created']);
    expect(JSON.stringify(events)).not.toContain('demo-key');
    await expect(wecomChannel(t.db, owner, '研发群')).rejects.toThrow('通道名称已存在');
  });

  it('邮件通道：默认每分钟 60；返回非敏感字段，不含密码；留空密码表示不变', async () => {
    const ch = await createChannel(t.db, owner, { kind: 'email', name: '邮件', config: EMAIL }, TEST_DEPS);
    expect(ch.rateLimitPerMin).toBe(60);
    expect(ch.settings).toEqual({ host: 'smtp.example.com', port: 465, secure: true, user: 'robot@example.com', from: 'robot@example.com', to: ['pm@example.com', 'dev@example.com'] });
    expect(JSON.stringify(ch)).not.toContain('demo-password-1');
    const updated = await updateChannel(t.db, owner, ch.id, { config: { pass: '', to: ['pm@example.com'] } }, TEST_DEPS);
    expect(updated.configHint).toBe('smtp.example.com:465 · robot@example.com → 1 个收件人');
    const all = await listChannels(t.db, owner, TEST_DEPS);
    expect(JSON.stringify(all)).not.toContain('demo-password-1');
  });

  it('修改网址：提示更新，事件 changes 只记提示；名称、上限、产品范围、启用', async () => {
    const ch = await wecomChannel(t.db, owner, '改址群');
    const updated = await updateChannel(
      t.db,
      owner,
      ch.id,
      { name: '改址群 2', rateLimitPerMin: 10, allowedProductIds: [productId], enabled: false, config: { url: 'http://127.0.0.1:9/cgi-bin/webhook/send?key=demo-key-9999' } },
      TEST_DEPS,
    );
    expect(updated).toMatchObject({ name: '改址群 2', rateLimitPerMin: 10, allowedProductIds: [productId], enabled: false, configHint: '…/send?key=****9999' });
    const [event] = await t.adminDb
      .select()
      .from(domainEvents)
      .where(and(eq(domainEvents.type, 'notification_channel.updated'), eq(domainEvents.subjectId, ch.id)));
    expect(event!.payload.changes).toEqual(
      expect.arrayContaining([
        { field: 'name', old: '改址群', new: '改址群 2' },
        { field: 'config', old: '…/send?key=****0001', new: '…/send?key=****9999' },
      ]),
    );
    expect(JSON.stringify(event)).not.toContain('demo-key');
    await expect(updateChannel(t.db, owner, ch.id, { rateLimitPerMin: 0 }, TEST_DEPS)).rejects.toThrow('1–600');
    await expect(updateChannel(t.db, owner, ch.id, { allowedProductIds: ['00000000-0000-7000-8000-000000000000'] }, TEST_DEPS)).rejects.toThrow('不存在的产品');
  });

  it('权限：只有组织管理员（且不是只读 Token）能管理；产品管理员只能看本产品可用的通道', async () => {
    const member = await asMember(t.db, owner, '成员甲');
    await expect(listChannels(t.db, member, TEST_DEPS)).rejects.toThrow('需要组织管理员权限');
    await expect(wecomChannel(t.db, readOnlyToken(owner), '只读建的')).rejects.toThrow('需要组织管理员权限');
    const pa = await asMember(t.db, owner, '产品管理员甲');
    await setProductRole(t.db, owner, productId, pa.memberId, 'admin');
    await wecomChannel(t.db, owner, '只给相册', { allowedProductIds: [otherProductId] });
    await wecomChannel(t.db, owner, '停用的群', { enabled: false });
    const names = (await listProductChannelOptions(t.db, pa, productId)).map((c) => c.name);
    expect(names).toContain('研发群');
    expect(names).not.toContain('只给相册');
    expect(names).not.toContain('停用的群');
    await expect(listProductChannelOptions(t.db, member, productId)).rejects.toThrow('权限不足');
  });

  it('删除：没有引用时删除；被定时推送引用或有发送记录时只能停用', async () => {
    const free = await wecomChannel(t.db, owner, '可删的群');
    await deleteChannel(t.db, owner, free.id);
    expect(await t.adminDb.select().from(notificationChannels).where(eq(notificationChannels.id, free.id))).toEqual([]);
    const used = await wecomChannel(t.db, owner, '被引用的群');
    await t.adminDb.insert(notificationSchedules).values({ orgId: owner.orgId, productId, name: '引用', cron: '0 9 * * *', source: 'digest', channelIds: [used.id] });
    await expect(deleteChannel(t.db, owner, used.id)).rejects.toThrow('只能停用');
    expect((await listChannels(t.db, owner, TEST_DEPS)).find((c) => c.id === used.id)!.usage.schedules).toBe(1);
  });
});
