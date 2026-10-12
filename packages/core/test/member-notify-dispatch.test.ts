import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { memberNotifications, members, notificationDeliveries } from '../src/db/schema';
import type { Actor } from '../src/domain-types';
import { mentionMarkup } from '../src/links/syntax';
import { getPersonalChannel, getPersonalEmailChannel, setPersonalChannel, setPersonalEmailChannel } from '../src/member-notifications/channels';
import { chunkLines, emailFor, type OutboundItem, wecomLine } from '../src/member-notifications/dispatch';
import { setNotificationPref } from '../src/member-notifications/prefs';
import { createChannel, updateChannel } from '../src/notifications/channels';
import { runNotificationTick } from '../src/notifications/worker';
import { addRequirementComment } from '../src/requirements/comments';
import { createRequirement } from '../src/requirements/requirements';
import { createPlaceholderMember } from '../src/tenancy/members';
import { createProduct } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, seedInstance } from './factories';
import { TEST_DEPS, wecomChannel } from './notify-helpers';
import { fakeTransport } from './notify-transport';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let productId: string;
let otherProductId: string;
let zhang: string;
let li: string;
let wu: string;
let channelId: string;
let mailId: string;
const fake = fakeTransport();
const deps = { ...TEST_DEPS, transport: fake.transport };
const tick = (now?: Date) => runNotificationTick(t.db, deps, now);
const contents = () => fake.calls.map((c) => (c.body as { markdown: { content: string } }).markdown.content);
const EMAIL = { host: 'smtp.example.com', port: 465, secure: true, user: 'robot@example.com', pass: 'demo-pass', from: 'robot@example.com', to: ['pm@example.com'] };

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  productId = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  otherProductId = (await createProduct(t.db, owner, { name: '相册', key: 'PIC' })).id;
  zhang = (await createPlaceholderMember(t.db, owner, { displayName: '张三', email: 'zhang@example.com' })).id;
  li = (await createPlaceholderMember(t.db, owner, { displayName: '李四' })).id;
  wu = (await createPlaceholderMember(t.db, owner, { displayName: '吴六' })).id;
  await t.adminDb.update(members).set({ wecomUserid: 'zhangsan' }).where(eq(members.id, zhang));
  await t.adminDb.update(members).set({ wecomUserid: 'lisi' }).where(eq(members.id, li));
  channelId = (await wecomChannel(t.db, owner, '研发群', { rateLimitPerMin: 100 })).id;
  mailId = (await createChannel(t.db, owner, { kind: 'email', name: '通知邮件', config: EMAIL }, TEST_DEPS)).id;
  await tick();
});
afterAll(() => t.cleanup());
beforeEach(() => fake.reset(() => ({ status: 200, text: '{"errcode":0,"errmsg":"ok"}' })));

describe('个人提醒通道', () => {
  it('产品管理员设置：只能选对本产品可用、已启用的企业微信通道；可以清空', async () => {
    expect(await getPersonalChannel(t.db, owner, productId)).toEqual({ channelId: null });
    const unusable = '个人提醒通道只能选择对本产品可用、已启用的企业微信机器人通道';
    await expect(setPersonalChannel(t.db, owner, productId, mailId)).rejects.toThrow(unusable);
    const off = await wecomChannel(t.db, owner, '停用群', { enabled: false });
    await expect(setPersonalChannel(t.db, owner, productId, off.id)).rejects.toThrow(unusable);
    const elsewhere = await wecomChannel(t.db, owner, '相册群', { allowedProductIds: [otherProductId] });
    await expect(setPersonalChannel(t.db, owner, productId, elsewhere.id)).rejects.toThrow(unusable);
    expect(await setPersonalChannel(t.db, owner, productId, channelId)).toEqual({ channelId });
    const editor = await asMember(t.db, owner, '编辑');
    await expect(setPersonalChannel(t.db, editor, productId, null)).rejects.toThrow('权限不足');
  });

  it('组织管理员设置个人通知邮件通道：只能选启用的邮件通道', async () => {
    expect(await getPersonalEmailChannel(t.db, owner)).toEqual({ channelId: null });
    await expect(setPersonalEmailChannel(t.db, owner, channelId)).rejects.toThrow('个人通知邮件通道只能选择已启用的邮件通道');
    expect(await setPersonalEmailChannel(t.db, owner, mailId)).toEqual({ channelId: mailId });
    const editor = await asMember(t.db, owner, '编辑乙');
    await expect(setPersonalEmailChannel(t.db, editor, null)).rejects.toThrow('需要组织管理员权限');
  });
});

describe('企业微信与邮件分发', () => {
  it('同一轮同一产品合并为一条 markdown 并 @ 到本人；未绑定的人只有站内通知', async () => {
    const r = await createRequirement(t.db, owner, productId, { title: '登录页', ownerMemberId: zhang });
    await addRequirementComment(t.db, owner, r.id, { body: `${mentionMarkup(li, '李四')} ${mentionMarkup(wu, '吴六')} 看下` });
    const summary = await tick();
    expect(summary.sent).toBe(1);
    expect(contents()).toEqual([
      [
        `<@zhangsan> Owner 把你设为需求负责人：[PAN-1 登录页](http://flower.example.com/acme/requirements/PAN-1)`,
        `<@lisi> Owner 在评论中 @ 了你：[PAN-1 登录页](http://flower.example.com/acme/requirements/PAN-1)`,
      ].join('\n'),
    ]);
    expect(await t.adminDb.select().from(memberNotifications).where(eq(memberNotifications.memberId, wu))).toHaveLength(1);
    const [d] = await t.adminDb.select().from(notificationDeliveries).where(eq(notificationDeliveries.kind, 'personal'));
    expect(d).toMatchObject({ channelId, status: 'sent', ruleId: null, scheduleId: null });
  });

  it('邮件：偏好开启的人每轮合并成一封，发到成员邮箱；没有邮箱的人不发', async () => {
    const zhangActor: Actor = { ...owner, memberId: zhang, orgRole: 'member', accountId: null };
    await setNotificationPref(t.db, zhangActor, 'assigned', { inApp: true, wecom: false, email: true });
    await createRequirement(t.db, owner, productId, { title: '分享页', ownerMemberId: zhang });
    await createRequirement(t.db, owner, productId, { title: '回收站', ownerMemberId: zhang });
    await tick();
    expect(fake.mails).toEqual([
      {
        to: ['zhang@example.com'],
        subject: 'Flower：你有 2 条新通知',
        text: [
          'Owner 把你设为需求负责人：PAN-2 分享页',
          'http://flower.example.com/acme/requirements/PAN-2',
          '',
          'Owner 把你设为需求负责人：PAN-3 回收站',
          'http://flower.example.com/acme/requirements/PAN-3',
          '',
          '在 Flower 的个人设置里可以修改通知偏好。',
        ].join('\n'),
      },
    ]);
    expect(contents()).toEqual([]);
  });

  it('个人提醒通道停用或产品没有指定时不发企业微信，站内照常', async () => {
    await updateChannel(t.db, owner, channelId, { enabled: false }, TEST_DEPS);
    const r = await createRequirement(t.db, owner, productId, { title: '上传', ownerMemberId: li });
    await tick();
    expect(fake.calls).toEqual([]);
    expect((await t.adminDb.select().from(memberNotifications).where(and(eq(memberNotifications.memberId, li), eq(memberNotifications.subjectId, r.id))))).toHaveLength(1);
    await updateChannel(t.db, owner, channelId, { enabled: true }, TEST_DEPS);
    await createRequirement(t.db, owner, otherProductId, { title: '相册首页', ownerMemberId: li });
    await tick();
    expect(fake.calls).toEqual([]);
  });

  it('两个实例同时处理：每条事件只处理一次，个人提醒只写一次', async () => {
    const r = await createRequirement(t.db, owner, productId, { title: '并发', ownerMemberId: li });
    const now = new Date();
    await Promise.all([tick(now), tick(now)]);
    await tick();
    const rows = (await t.adminDb.select().from(notificationDeliveries).where(eq(notificationDeliveries.kind, 'personal'))).filter((d) =>
      JSON.stringify(d.payload).includes('PAN-5 并发'),
    );
    expect(rows).toHaveLength(1);
    expect((await t.adminDb.select().from(memberNotifications).where(and(eq(memberNotifications.memberId, li), eq(memberNotifications.subjectId, r.id))))).toHaveLength(1);
  });

  it('发送时个人提醒的企业微信请求体不在企业微信机器人通道上：放弃，不发出', async () => {
    const [row] = await t.adminDb
      .insert(notificationDeliveries)
      .values({ orgId: owner.orgId, kind: 'personal', channelId: mailId, payload: { type: 'json', body: { msgtype: 'markdown', markdown: { content: 'x' } } }, status: 'pending', nextAttemptAt: new Date() })
      .returning();
    await tick();
    expect(fake.calls).toEqual([]);
    expect(fake.mails).toEqual([]);
    const [d] = await t.adminDb.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, row!.id));
    expect(d).toMatchObject({ status: 'dead', response: '个人提醒只能经企业微信机器人或邮件通道发送，未发送' });
  });
});

describe('消息拼装', () => {
  const item = (over: Partial<OutboundItem> = {}): OutboundItem => ({
    productId: 'p',
    memberId: 'm',
    email: 'm@example.com',
    wecomUserid: 'u1',
    viaWecom: true,
    viaEmail: false,
    actorName: '张三',
    body: '在评论中 @ 了你',
    title: 'PAN-1 [草稿] 标题',
    url: '/acme/requirements/PAN-1',
    ...over,
  });

  it('企微一行：标题里的方括号去掉；没有操作人时为「系统」', () => {
    expect(wecomLine(item(), 'https://flower.example.com/')).toBe('<@u1> 张三 在评论中 @ 了你：[PAN-1  草稿  标题](https://flower.example.com/acme/requirements/PAN-1)');
    expect(wecomLine(item({ actorName: null }), 'https://flower.example.com')).toContain('<@u1> 系统 ');
  });

  it('按行合并，每条不超过 4096 字节；单行超长时截断', () => {
    const line = 'a'.repeat(1500);
    const chunks = chunkLines([line, line, line, line]);
    expect(chunks).toHaveLength(2);
    expect(chunks.every((c) => Buffer.byteLength(c, 'utf8') <= 4096)).toBe(true);
    expect(chunks[0]!.split('\n')).toHaveLength(2);
    const huge = chunkLines(['中'.repeat(3000)]);
    expect(huge).toHaveLength(1);
    expect(Buffer.byteLength(huge[0]!, 'utf8')).toBeLessThanOrEqual(4096);
  });

  it('邮件主题带条数', () => {
    expect(emailFor([item(), item()], 'https://flower.example.com').subject).toBe('Flower：你有 2 条新通知');
  });
});
