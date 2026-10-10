import { asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { requireProductRole } from '../access/permissions';
import type { Db } from '../db/client';
import { notificationChannels, notificationDeliveries, notificationDigestItems, notificationRules, notificationSchedules } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import { assertUsableChannelsTx, type ChannelOption, channelOption } from './channels';
import { isNotifiableEventType, type NotifiableEventType, RULE_MODES, type RuleFilter, type RuleMode } from './constants';
import { assertTemplateIdTx } from './message-templates';

export type RuleRow = typeof notificationRules.$inferSelect;
export type RuleView = {
  id: string;
  productId: string;
  name: string;
  eventTypes: NotifiableEventType[];
  filter: RuleFilter;
  channelIds: string[];
  channels: ChannelOption[];
  templateId: string | null;
  mode: RuleMode;
  digestScheduleId: string | null;
  digestScheduleName: string | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
};
export type RuleInput = {
  name: string;
  eventTypes: string[];
  filter?: RuleFilter;
  channelIds?: string[];
  templateId?: string | null;
  mode?: RuleMode;
  digestScheduleId?: string | null;
  enabled?: boolean;
};
export type RulePatch = Partial<RuleInput>;

const NOT_FOUND = '规则不存在';
const values = (item: z.ZodString) => z.array(item).max(50).optional();
const FILTER = z
  .object({
    states: values(z.string().min(1).max(64)),
    priorities: values(z.string().min(1).max(32)),
    nodeIds: values(z.string().uuid()),
    documentStatuses: values(z.string().min(1).max(32)),
    fields: values(z.string().min(1).max(64)),
  })
  .strict();

/** 校验过滤条件，去掉空数组。 */
export function parseRuleFilter(raw: unknown): RuleFilter {
  const r = FILTER.safeParse(raw ?? {});
  if (!r.success) throw new AppError('invalid', '过滤条件有误', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  return Object.fromEntries(Object.entries(r.data).filter(([, v]) => Array.isArray(v) && v.length > 0)) as RuleFilter;
}

function assertName(name: string): string {
  const v = name.trim();
  if (!v || v.length > 50) throw new AppError('invalid', '规则名称不能为空，且不超过 50 个字');
  return v;
}

function assertEventTypes(types: string[]): NotifiableEventType[] {
  const unique = [...new Set(types)];
  if (unique.length === 0) throw new AppError('invalid', '至少选择一种事件');
  const bad = unique.filter((x) => !isNotifiableEventType(x));
  if (bad.length > 0) throw new AppError('invalid', `不支持订阅的事件：${bad.join('、')}`);
  return unique as NotifiableEventType[];
}

function assertMode(mode: string): RuleMode {
  if (!(RULE_MODES as readonly string[]).includes(mode)) throw new AppError('invalid', '推送方式无效');
  return mode as RuleMode;
}

/** 即时规则：校验通道；摘要规则：不用通道，摘要定时推送必须是本产品的 digest。 */
async function resolveTargetTx(
  tx: Tx,
  productId: string,
  mode: RuleMode,
  channelIds: string[],
  digestScheduleId: string | null | undefined,
): Promise<{ channelIds: string[]; digestScheduleId: string | null }> {
  if (mode === 'immediate') return { channelIds: await assertUsableChannelsTx(tx, channelIds, productId, { min: 1 }), digestScheduleId: null };
  if (!digestScheduleId) throw new AppError('invalid', '合并到变更摘要时请选择摘要定时推送');
  const [s] = await tx
    .select({ id: notificationSchedules.id, productId: notificationSchedules.productId, source: notificationSchedules.source })
    .from(notificationSchedules)
    .where(eq(notificationSchedules.id, digestScheduleId));
  if (!s || s.source !== 'digest' || s.productId !== productId) throw new AppError('invalid', '摘要定时推送不存在，或不是本产品的变更摘要');
  return { channelIds: [], digestScheduleId: s.id };
}

async function viewsTx(tx: Tx, rows: RuleRow[]): Promise<RuleView[]> {
  const channelIds = [...new Set(rows.flatMap((r) => r.channelIds))];
  const chans = channelIds.length ? await tx.select().from(notificationChannels).where(inArray(notificationChannels.id, channelIds)) : [];
  const scheduleIds = [...new Set(rows.map((r) => r.digestScheduleId).filter((x): x is string => !!x))];
  const schedules = scheduleIds.length
    ? await tx.select({ id: notificationSchedules.id, name: notificationSchedules.name }).from(notificationSchedules).where(inArray(notificationSchedules.id, scheduleIds))
    : [];
  return rows.map((r) => ({
    id: r.id,
    productId: r.productId,
    name: r.name,
    eventTypes: r.eventTypes as NotifiableEventType[],
    filter: r.filter,
    channelIds: r.channelIds,
    channels: r.channelIds.flatMap((id) => {
      const c = chans.find((x) => x.id === id);
      return c ? [channelOption(c)] : [];
    }),
    templateId: r.templateId,
    mode: r.mode,
    digestScheduleId: r.digestScheduleId,
    digestScheduleName: schedules.find((s) => s.id === r.digestScheduleId)?.name ?? null,
    enabled: r.enabled,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

export async function listRules(db: Db, actor: Actor, productId: string): Promise<RuleView[]> {
  return withOrg(db, actor.orgId, async (tx) => {
    await requireProductRole(tx, actor, productId, 'admin');
    const rows = await tx.select().from(notificationRules).where(eq(notificationRules.productId, productId)).orderBy(asc(notificationRules.name));
    return viewsTx(tx, rows);
  });
}

export async function createRule(db: Db, actor: Actor, productId: string, input: RuleInput): Promise<RuleView> {
  const name = assertName(input.name);
  const eventTypes = assertEventTypes(input.eventTypes);
  const filter = parseRuleFilter(input.filter);
  const mode = assertMode(input.mode ?? 'immediate');
  return withOrg(db, actor.orgId, async (tx) => {
    await requireProductRole(tx, actor, productId, 'admin');
    const target = await resolveTargetTx(tx, productId, mode, input.channelIds ?? [], input.digestScheduleId);
    const templateId = await assertTemplateIdTx(tx, input.templateId);
    const [row] = await tx
      .insert(notificationRules)
      .values({ orgId: actor.orgId, productId, name, eventTypes, filter, mode, templateId, enabled: input.enabled ?? true, ...target })
      .returning();
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId,
      type: 'notification_rule.created',
      subjectType: 'notification_rule',
      subjectId: row!.id,
      actor,
      payload: { name, eventTypes, filter, mode, templateId, enabled: row!.enabled, ...target },
    });
    return (await viewsTx(tx, [row!]))[0]!;
  });
}

export async function updateRule(db: Db, actor: Actor, id: string, patch: RulePatch): Promise<RuleView> {
  return withOrg(db, actor.orgId, async (tx) => {
    const [cur] = await tx.select().from(notificationRules).where(eq(notificationRules.id, id)).for('no key update');
    if (!cur) throw new AppError('not_found', NOT_FOUND);
    await requireProductRole(tx, actor, cur.productId, 'admin');
    const mode = patch.mode === undefined ? cur.mode : assertMode(patch.mode);
    const targetChanged = patch.mode !== undefined || patch.channelIds !== undefined || patch.digestScheduleId !== undefined;
    const target = targetChanged
      ? await resolveTargetTx(tx, cur.productId, mode, patch.channelIds ?? cur.channelIds, patch.digestScheduleId === undefined ? cur.digestScheduleId : patch.digestScheduleId)
      : { channelIds: cur.channelIds, digestScheduleId: cur.digestScheduleId };
    const next = {
      name: patch.name === undefined ? cur.name : assertName(patch.name),
      eventTypes: patch.eventTypes === undefined ? cur.eventTypes : assertEventTypes(patch.eventTypes),
      filter: patch.filter === undefined ? cur.filter : parseRuleFilter(patch.filter),
      mode,
      channelIds: target.channelIds,
      digestScheduleId: target.digestScheduleId,
      templateId: patch.templateId === undefined ? cur.templateId : await assertTemplateIdTx(tx, patch.templateId),
      enabled: patch.enabled ?? cur.enabled,
    };
    const changes = (Object.keys(next) as Array<keyof typeof next>)
      .filter((k) => JSON.stringify(next[k]) !== JSON.stringify(cur[k]))
      .map((k) => ({ field: k, old: cur[k], new: next[k] }));
    if (changes.length === 0) return (await viewsTx(tx, [cur]))[0]!;
    const [row] = await tx
      .update(notificationRules)
      .set({ ...next, updatedAt: new Date() })
      .where(eq(notificationRules.id, id))
      .returning();
    await recordEvent(tx, { orgId: actor.orgId, productId: cur.productId, type: 'notification_rule.updated', subjectType: 'notification_rule', subjectId: id, actor, payload: { changes } });
    return (await viewsTx(tx, [row!]))[0]!;
  });
}

export async function deleteRule(db: Db, actor: Actor, id: string): Promise<void> {
  return withOrg(db, actor.orgId, async (tx) => {
    const [cur] = await tx.select().from(notificationRules).where(eq(notificationRules.id, id)).for('update');
    if (!cur) throw new AppError('not_found', NOT_FOUND);
    await requireProductRole(tx, actor, cur.productId, 'admin');
    const [delivery] = await tx.select({ id: notificationDeliveries.id }).from(notificationDeliveries).where(eq(notificationDeliveries.ruleId, id)).limit(1);
    const [item] = await tx.select({ id: notificationDigestItems.id }).from(notificationDigestItems).where(eq(notificationDigestItems.ruleId, id)).limit(1);
    if (delivery || item) throw new AppError('conflict', '已有发送记录的规则只能停用');
    await tx.delete(notificationRules).where(eq(notificationRules.id, id));
    await recordEvent(tx, { orgId: actor.orgId, productId: cur.productId, type: 'notification_rule.deleted', subjectType: 'notification_rule', subjectId: id, actor, payload: { name: cur.name } });
  });
}
