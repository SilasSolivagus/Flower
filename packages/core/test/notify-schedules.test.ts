import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { domainEvents, notificationDeliveries, notificationDigestItems, notificationRules } from '../src/db/schema';
import type { Actor } from '../src/domain-types';
import { updateChannel } from '../src/notifications/channels';
import { createRule, updateRule } from '../src/notifications/rules';
import { createSchedule, deleteSchedule, getSchedule, listSchedules, updateSchedule } from '../src/notifications/schedules';
import { createRequirement } from '../src/requirements/requirements';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, readOnlyToken, seedInstance } from './factories';
import { TEST_DEPS, wecomChannel } from './notify-helpers';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let pa: Actor;
let productId: string;
let otherProductId: string;
let channelId: string;
const NOW = new Date('2026-10-10T03:00:00Z'); // 周六 11:00（上海）

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  productId = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  otherProductId = (await createProduct(t.db, owner, { name: '相册', key: 'PIC' })).id;
  pa = await asMember(t.db, owner, '产品管理员丙');
  await setProductRole(t.db, owner, productId, pa.memberId, 'admin');
  channelId = (await wecomChannel(t.db, owner, '研发群')).id;
});
afterAll(() => t.cleanup());

const overview = (extra: Record<string, unknown> = {}) => ({ productId, name: '日报', cron: '0 19 * * 1-5', source: 'overview_card' as const, channelIds: [channelId], ...extra });

describe('定时推送', () => {
  it('产品管理员新建：按时区算出下一次；带通道与产品；记事件', async () => {
    const s = await createSchedule(t.db, pa, overview(), { now: NOW });
    expect(s).toMatchObject({
      name: '日报',
      cron: '0 19 * * 1-5',
      timezone: 'Asia/Shanghai',
      source: 'overview_card',
      sourceConfig: { image: true },
      enabled: true,
      failThreshold: 1,
      alertState: 'normal',
      product: { key: 'PAN' },
      channels: [{ id: channelId, name: '研发群', kind: 'wecom_robot' }],
    });
    expect(s.nextRunAt!.toISOString()).toBe('2026-10-12T11:00:00.000Z');
    const events = await t.adminDb.select().from(domainEvents).where(eq(domainEvents.subjectId, s.id));
    expect(events.map((e) => e.type)).toEqual(['notification_schedule.created']);
  });

  it('校验：5 段 cron、时区、通道、内容来源设置、产品', async () => {
    await expect(createSchedule(t.db, pa, overview({ cron: '0 0 19 * * 1' }))).rejects.toThrow('5 段');
    await expect(createSchedule(t.db, pa, overview({ timezone: 'Mars/Base' }))).rejects.toThrow('时区');
    await expect(createSchedule(t.db, pa, overview({ channelIds: [] }))).rejects.toThrow('请选择 1–10 个通道');
    const off = await wecomChannel(t.db, owner, '停用群', { enabled: false });
    await expect(createSchedule(t.db, pa, overview({ channelIds: [off.id] }))).rejects.toThrow('通道不存在、已停用或不允许本产品使用');
    const picOnly = await wecomChannel(t.db, owner, '相册群', { allowedProductIds: [otherProductId] });
    await expect(createSchedule(t.db, pa, overview({ channelIds: [picOnly.id] }))).rejects.toThrow('不允许本产品使用');
    await expect(createSchedule(t.db, pa, overview({ source: 'new_requirements', sourceConfig: { emptyBehavior: 'maybe' } }))).rejects.toThrow('内容来源的设置有误');
    await expect(createSchedule(t.db, pa, overview({ productId: '' }))).rejects.toThrow('请选择产品');
    const nr = await createSchedule(t.db, pa, overview({ name: '新需求', source: 'new_requirements', cron: '30 9 * * *' }), { now: NOW });
    expect(nr.sourceConfig).toEqual({ emptyBehavior: 'skip', onlineSourceKeys: [] });
  });

  it('校验：不存在的模板 id 被拒绝', async () => {
    await expect(createSchedule(t.db, pa, overview({ templateId: '00000000-0000-0000-0000-000000000000' }))).rejects.toThrow('模板不存在');
  });

  it('权限：编辑、只读 Token 不能管理；产品管理员只看本产品；组织管理员看全部', async () => {
    const editor = await asMember(t.db, owner, '编辑丙');
    await expect(createSchedule(t.db, editor, overview())).rejects.toThrow('权限不足');
    await expect(createSchedule(t.db, readOnlyToken(owner), overview())).rejects.toThrow('权限不足');
    await expect(listSchedules(t.db, pa)).rejects.toThrow('需要组织管理员权限');
    expect((await listSchedules(t.db, pa, { productId })).every((s) => s.productId === productId)).toBe(true);
    await expect(listSchedules(t.db, pa, { productId: otherProductId })).rejects.toThrow('权限不足');
    await createSchedule(t.db, owner, overview({ productId: otherProductId, name: '相册日报', channelIds: [channelId] }), { now: NOW });
    expect((await listSchedules(t.db, owner)).map((s) => s.name)).toEqual(expect.arrayContaining(['日报', '新需求', '相册日报']));
  });

  it('修改：停用清空下一次；改 cron 重算；只改名称时不校验已停用的通道', async () => {
    const s = await createSchedule(t.db, pa, overview({ name: '可改' }), { now: NOW });
    expect((await updateSchedule(t.db, pa, s.id, { enabled: false }, { now: NOW })).nextRunAt).toBeNull();
    const re = await updateSchedule(t.db, pa, s.id, { enabled: true, cron: '30 9 * * *' }, { now: NOW });
    expect(re.nextRunAt!.toISOString()).toBe('2026-10-11T01:30:00.000Z');
    const temp = await wecomChannel(t.db, owner, '后来停用的群');
    const s2 = await createSchedule(t.db, pa, overview({ name: '用后来停用的群', channelIds: [temp.id] }), { now: NOW });
    await updateChannel(t.db, owner, temp.id, { enabled: false }, TEST_DEPS);
    expect((await updateSchedule(t.db, pa, s2.id, { name: '改个名' })).name).toBe('改个名');
    await expect(updateSchedule(t.db, pa, s2.id, { channelIds: [temp.id] })).rejects.toThrow('已停用');
    const [ev] = await t.adminDb
      .select()
      .from(domainEvents)
      .where(and(eq(domainEvents.type, 'notification_schedule.updated'), eq(domainEvents.subjectId, s.id)))
      .orderBy(asc(domainEvents.occurredAt));
    expect(ev!.payload.changes).toEqual([{ field: 'enabled', old: true, new: false }]);
    expect((await getSchedule(t.db, pa, s.id)).cron).toBe('30 9 * * *');
  });

  it('删除：有发送记录或被摘要规则引用时只能停用', async () => {
    const free = await createSchedule(t.db, pa, overview({ name: '可删' }), { now: NOW });
    await deleteSchedule(t.db, pa, free.id);
    await expect(getSchedule(t.db, pa, free.id)).rejects.toThrow('定时推送不存在');
    const sent = await createSchedule(t.db, pa, overview({ name: '发过的' }), { now: NOW });
    await t.adminDb.insert(notificationDeliveries).values({ orgId: owner.orgId, kind: 'schedule', scheduleId: sent.id, channelId });
    await expect(deleteSchedule(t.db, pa, sent.id)).rejects.toThrow('已有发送记录的定时推送只能停用');
    const digest = await createSchedule(t.db, pa, overview({ name: '摘要', source: 'digest', cron: '0 18 * * *' }), { now: NOW });
    await t.adminDb.insert(notificationRules).values({ orgId: owner.orgId, productId, name: '并入摘要', eventTypes: ['requirement.created'], mode: 'digest', digestScheduleId: digest.id });
    await expect(deleteSchedule(t.db, pa, digest.id)).rejects.toThrow('有摘要规则使用该定时推送');
  });

  it('删除：规则已改用其他定时推送时，一并删除留下的未发送摘要条目', async () => {
    const a = await createSchedule(t.db, pa, overview({ name: '旧摘要', source: 'digest', cron: '0 18 * * *' }), { now: NOW });
    const b = await createSchedule(t.db, pa, overview({ name: '新摘要', source: 'digest', cron: '0 18 * * *' }), { now: NOW });
    const rule = await createRule(t.db, pa, productId, { name: '改投摘要', eventTypes: ['requirement.created'], mode: 'digest', digestScheduleId: a.id });
    await createRequirement(t.db, owner, productId, { title: '进入旧摘要' });
    const itemsOf = (scheduleId: string) => t.adminDb.select().from(notificationDigestItems).where(eq(notificationDigestItems.scheduleId, scheduleId));
    expect(await itemsOf(a.id)).toHaveLength(1);
    await updateRule(t.db, pa, rule.id, { digestScheduleId: b.id });
    await deleteSchedule(t.db, pa, a.id);
    await expect(getSchedule(t.db, pa, a.id)).rejects.toThrow('定时推送不存在');
    expect(await itemsOf(a.id)).toHaveLength(0);
    const events = await t.adminDb.select().from(domainEvents).where(eq(domainEvents.subjectId, a.id));
    expect(events.map((e) => e.type)).toContain('notification_schedule.deleted');
  });
});
