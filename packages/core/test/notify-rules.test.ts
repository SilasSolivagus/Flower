import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { domainEvents, notificationDeliveries, notificationDigestItems, notificationRules, requirements } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import { listFields } from '../src/definitions/fields';
import { createDocument, transitionDocument } from '../src/documents/documents';
import type { Actor } from '../src/domain-types';
import { recordEvent } from '../src/events';
import { updateChannel } from '../src/notifications/channels';
import { ruleMatches } from '../src/notifications/match';
import { createRule, deleteRule, listRules, updateRule } from '../src/notifications/rules';
import { createSchedule } from '../src/notifications/schedules';
import { createRequirement, setRequirementField } from '../src/requirements/requirements';
import { transitionRequirement } from '../src/requirements/transitions';
import { createStructureNode } from '../src/structure/nodes';
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
let priority: Record<string, string>;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  productId = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  otherProductId = (await createProduct(t.db, owner, { name: '相册', key: 'PIC' })).id;
  pa = await asMember(t.db, owner, '产品管理员丁');
  await setProductRole(t.db, owner, productId, pa.memberId, 'admin');
  channelId = (await wecomChannel(t.db, owner, '研发群')).id;
  const field = (await listFields(t.db, owner, { productId })).find((f) => f.key === 'priority')!;
  priority = Object.fromEntries(field.options.map((o) => [o.key, o.id]));
});
afterAll(() => t.cleanup());

const deliveriesOf = (ruleId: string) => t.adminDb.select().from(notificationDeliveries).where(eq(notificationDeliveries.ruleId, ruleId));

describe('过滤条件（纯函数）', () => {
  const req = { requirement: { stateKey: 'doing', priorities: ['p0'], nodePath: ['mod', 'area'] }, documentStatus: null, changedFields: null };
  it('条件之间且、条件内或；空条件通过', () => {
    expect(ruleMatches({}, req)).toBe(true);
    expect(ruleMatches({ states: ['todo', 'doing'], priorities: ['p0'] }, req)).toBe(true);
    expect(ruleMatches({ states: ['doing'], priorities: ['p1'] }, req)).toBe(false);
    expect(ruleMatches({ nodeIds: ['area'] }, req)).toBe(true);
    expect(ruleMatches({ nodeIds: ['other'] }, req)).toBe(false);
  });
  it('不适用于该事件的条件视为通过', () => {
    const doc = { requirement: null, documentStatus: 'review', changedFields: null };
    expect(ruleMatches({ states: ['doing'], documentStatuses: ['review'] }, doc)).toBe(true);
    expect(ruleMatches({ documentStatuses: ['approved'] }, doc)).toBe(false);
    expect(ruleMatches({ fields: ['priority'] }, req)).toBe(true);
    expect(ruleMatches({ fields: ['priority'] }, { ...req, changedFields: ['platform'] })).toBe(false);
  });
});

describe('事件规则', () => {
  it('产品管理员新建即时规则；编辑与只读 Token 不能；校验事件类型、通道与摘要定时推送', async () => {
    const rule = await createRule(t.db, pa, productId, { name: '新需求提醒', eventTypes: ['requirement.created'], channelIds: [channelId] });
    expect(rule).toMatchObject({ name: '新需求提醒', mode: 'immediate', eventTypes: ['requirement.created'], filter: {}, channels: [{ id: channelId, name: '研发群' }], enabled: true });
    expect((await listRules(t.db, pa, productId)).map((r) => r.id)).toContain(rule.id);
    const editor = await asMember(t.db, owner, '编辑丁');
    await expect(createRule(t.db, editor, productId, { name: 'x', eventTypes: ['requirement.created'], channelIds: [channelId] })).rejects.toThrow('权限不足');
    await expect(createRule(t.db, readOnlyToken(owner), productId, { name: 'x', eventTypes: ['requirement.created'], channelIds: [channelId] })).rejects.toThrow('权限不足');
    await expect(createRule(t.db, pa, productId, { name: 'x', eventTypes: ['comment.created'], channelIds: [channelId] })).rejects.toThrow('不支持订阅的事件');
    await expect(createRule(t.db, pa, productId, { name: 'x', eventTypes: ['requirement.created'] })).rejects.toThrow('请选择 1–10 个通道');
    await expect(createRule(t.db, pa, productId, { name: 'x', eventTypes: ['requirement.created'], mode: 'digest' })).rejects.toThrow('请选择摘要定时推送');
    const overview = await createSchedule(t.db, pa, { productId, name: '日报', cron: '0 19 * * 1-5', source: 'overview_card', channelIds: [channelId] });
    await expect(createRule(t.db, pa, productId, { name: 'x', eventTypes: ['requirement.created'], mode: 'digest', digestScheduleId: overview.id })).rejects.toThrow('不是本产品的变更摘要');
    await expect(createRule(t.db, pa, productId, { name: 'x', eventTypes: ['requirement.created'], channelIds: [channelId], filter: { nodeIds: ['not-a-uuid'] } })).rejects.toThrow('过滤条件有误');
  });

  it('匹配：新建需求在同一事务内写一条待发记录（未渲染）；其他产品的事件不匹配', async () => {
    const rule = (await listRules(t.db, pa, productId)).find((r) => r.name === '新需求提醒')!;
    const req = await createRequirement(t.db, owner, productId, { title: '离线下载' });
    const [event] = await t.adminDb.select().from(domainEvents).where(and(eq(domainEvents.subjectId, req.id), eq(domainEvents.type, 'requirement.created')));
    expect(await deliveriesOf(rule.id)).toMatchObject([{ kind: 'rule', channelId, eventId: event!.id, status: 'pending', payload: null, attempts: 0 }]);
    await createRequirement(t.db, owner, otherProductId, { title: '相册需求' });
    expect(await deliveriesOf(rule.id)).toHaveLength(1);
  });

  it('过滤：优先级、状态、结构树节点（含下级）、字段', async () => {
    const byPriority = await createRule(t.db, pa, productId, { name: 'P0 新需求', eventTypes: ['requirement.created'], channelIds: [channelId], filter: { priorities: ['p0'] } });
    await createRequirement(t.db, owner, productId, { title: '普通', fields: { priority: [priority.p2!] } });
    await createRequirement(t.db, owner, productId, { title: '紧急', fields: { priority: [priority.p0!] } });
    expect(await deliveriesOf(byPriority.id)).toHaveLength(1);

    const byState = await createRule(t.db, pa, productId, { name: '开始开发', eventTypes: ['requirement.state_changed'], channelIds: [channelId], filter: { states: ['doing'] } });
    const r = await createRequirement(t.db, owner, productId, { title: '流转' });
    await transitionRequirement(t.db, owner, r.id, { to: 'todo' });
    expect(await deliveriesOf(byState.id)).toHaveLength(0);
    await transitionRequirement(t.db, owner, r.id, { to: 'doing' });
    expect(await deliveriesOf(byState.id)).toHaveLength(1);

    const area = await createStructureNode(t.db, owner, productId, { name: '存储' });
    const mod = await createStructureNode(t.db, owner, productId, { parentId: area.id, name: '上传' });
    const byNode = await createRule(t.db, pa, productId, { name: '存储域', eventTypes: ['requirement.created'], channelIds: [channelId], filter: { nodeIds: [area.id] } });
    await createRequirement(t.db, owner, productId, { title: '模块下的需求', nodeId: mod.id });
    await createRequirement(t.db, owner, productId, { title: '没有节点' });
    expect(await deliveriesOf(byNode.id)).toHaveLength(1);

    const byField = await createRule(t.db, pa, productId, { name: '改优先级', eventTypes: ['requirement.field_changed'], channelIds: [channelId], filter: { fields: ['priority'] } });
    await setRequirementField(t.db, owner, r.id, 'priority', [priority.p1!]);
    expect(await deliveriesOf(byField.id)).toHaveLength(1);
  });

  it('PRD 状态过滤；需求条件对 PRD 事件视为通过', async () => {
    const rule = await createRule(t.db, pa, productId, {
      name: 'PRD 提交评审',
      eventTypes: ['document.status_changed'],
      channelIds: [channelId],
      filter: { documentStatuses: ['review'], states: ['doing'] },
    });
    const doc = await createDocument(t.db, owner, productId, { title: '下载 PRD' });
    await transitionDocument(t.db, owner, doc.id, { to: 'review' });
    await transitionDocument(t.db, owner, doc.id, { to: 'approved' });
    expect(await deliveriesOf(rule.id)).toHaveLength(1);
  });

  it('摘要规则写摘要条目；停用的规则与停用的通道不产生记录', async () => {
    const digest = await createSchedule(t.db, pa, { productId, name: '变更摘要', cron: '0 18 * * *', source: 'digest', channelIds: [channelId] });
    const rule = await createRule(t.db, pa, productId, { name: '并入摘要', eventTypes: ['requirement.created'], mode: 'digest', digestScheduleId: digest.id, channelIds: [channelId] });
    expect(rule).toMatchObject({ mode: 'digest', channelIds: [], digestScheduleName: '变更摘要' });
    await createRequirement(t.db, owner, productId, { title: '进摘要' });
    expect(await t.adminDb.select().from(notificationDigestItems).where(eq(notificationDigestItems.ruleId, rule.id))).toMatchObject([{ scheduleId: digest.id, runId: null, consumedAt: null }]);

    const quiet = await createRule(t.db, pa, productId, { name: '停用的规则', eventTypes: ['requirement.created'], channelIds: [channelId], enabled: false });
    const temp = await wecomChannel(t.db, owner, '会停用的群');
    const viaTemp = await createRule(t.db, pa, productId, { name: '走会停用的群', eventTypes: ['requirement.created'], channelIds: [temp.id] });
    await updateChannel(t.db, owner, temp.id, { enabled: false }, TEST_DEPS);
    await createRequirement(t.db, owner, productId, { title: '没人收' });
    expect(await deliveriesOf(quiet.id)).toHaveLength(0);
    expect(await deliveriesOf(viaTemp.id)).toHaveLength(0);
  });

  it('修改与删除：改为摘要规则；有发送记录时只能停用', async () => {
    const rule = await createRule(t.db, pa, productId, { name: '可删规则', eventTypes: ['release.released'], channelIds: [channelId] });
    const updated = await updateRule(t.db, pa, rule.id, { name: '可删规则 2', filter: { priorities: ['p0'] }, enabled: false });
    expect(updated).toMatchObject({ name: '可删规则 2', filter: { priorities: ['p0'] }, enabled: false });
    await deleteRule(t.db, pa, rule.id);
    expect((await listRules(t.db, pa, productId)).some((r) => r.id === rule.id)).toBe(false);
    const used = (await listRules(t.db, pa, productId)).find((r) => r.name === '新需求提醒')!;
    await expect(deleteRule(t.db, pa, used.id)).rejects.toThrow('已有发送记录的规则只能停用');
  });

  it('存储的过滤条件有误时只跳过该规则：同产品的其他规则照常写待发记录，业务写入提交，记一条警告', async () => {
    const bad = await createRule(t.db, owner, otherProductId, { name: '过滤条件损坏', eventTypes: ['requirement.created'], channelIds: [channelId], filter: { priorities: ['p0'] } });
    const good = await createRule(t.db, owner, otherProductId, { name: '正常规则', eventTypes: ['requirement.created'], channelIds: [channelId] });
    await t.adminDb.update(notificationRules).set({ filter: { priorities: 'p0' } as never }).where(eq(notificationRules.id, bad.id));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const req = await createRequirement(t.db, owner, otherProductId, { title: '过滤条件损坏时的需求' });
      expect(await t.adminDb.select({ id: requirements.id }).from(requirements).where(eq(requirements.id, req.id))).toHaveLength(1);
      const [event] = await t.adminDb.select().from(domainEvents).where(and(eq(domainEvents.subjectId, req.id), eq(domainEvents.type, 'requirement.created')));
      expect(await deliveriesOf(bad.id)).toHaveLength(0);
      expect(await deliveriesOf(good.id)).toMatchObject([{ eventId: event!.id, status: 'pending' }]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain(bad.id);
      expect(String(warn.mock.calls[0]![0])).toContain(event!.id);
    } finally {
      warn.mockRestore();
      await t.adminDb.update(notificationRules).set({ enabled: false }).where(eq(notificationRules.id, bad.id));
    }
  });

  it('匹配中出现数据库错误时回滚到 savepoint：外层事务仍可用，业务写入与领域事件照常提交', async () => {
    const rule = await createRule(t.db, owner, otherProductId, { name: '写入会报错', eventTypes: ['requirement.created'], channelIds: [channelId] });
    // 只对这条规则的待发记录报错，在 savepoint 里制造一个真实的 Postgres 错误
    await t.adminDb.execute(
      sql.raw(`create function test_reject_delivery() returns trigger language plpgsql as $$ begin raise exception 'test: delivery rejected'; end $$;
        create trigger test_reject_delivery before insert on notification_deliveries for each row when (new.rule_id = '${rule.id}') execute function test_reject_delivery();`),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const req = await createRequirement(t.db, owner, otherProductId, { title: '数据库报错时的需求' });
      expect(await t.adminDb.select({ id: requirements.id }).from(requirements).where(eq(requirements.id, req.id))).toHaveLength(1);
      const [event] = await t.adminDb.select().from(domainEvents).where(and(eq(domainEvents.subjectId, req.id), eq(domainEvents.type, 'requirement.created')));
      expect(event).toBeDefined();
      expect(await t.adminDb.select().from(notificationDeliveries).where(eq(notificationDeliveries.eventId, event!.id))).toHaveLength(0);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain(event!.id);
      expect(String(warn.mock.calls[0]![0])).toContain('test: delivery rejected');
      expect(String(warn.mock.calls[0]![0])).not.toContain('params');

      // 同一事务里 recordEvent 之后的语句仍能执行
      const after = await withOrg(t.db, owner.orgId, async (tx) => {
        const id = await recordEvent(tx, { orgId: owner.orgId, productId: otherProductId, type: 'requirement.created', subjectType: 'requirement', subjectId: req.id, actor: owner });
        const [row] = await tx.select({ id: domainEvents.id }).from(domainEvents).where(eq(domainEvents.id, id));
        return row;
      });
      expect(after).toBeDefined();
      expect(await t.adminDb.select({ id: domainEvents.id }).from(domainEvents).where(eq(domainEvents.id, after!.id))).toHaveLength(1);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
      await t.adminDb.execute(sql.raw('drop trigger test_reject_delivery on notification_deliveries; drop function test_reject_delivery();'));
      await t.adminDb.update(notificationRules).set({ enabled: false }).where(eq(notificationRules.id, rule.id));
    }
  });
});
