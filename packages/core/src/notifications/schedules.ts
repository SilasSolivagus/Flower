import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { requireOrgAdmin, requireProductRole } from '../access/permissions';
import type { Db } from '../db/client';
import { notificationChannels, notificationDeliveries, notificationDigestItems, notificationRules, notificationSchedules, products } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import { assertUsableChannelsTx, type ChannelOption, channelOption } from './channels';
import { type AlertState, SCHEDULE_DEFAULT_TIMEZONE, SCHEDULE_SOURCES, type ScheduleSource } from './constants';
import { assertCron, assertTimezone, nextRunAt } from './cron';
import { assertTemplateIdTx } from './message-templates';

export type ScheduleRow = typeof notificationSchedules.$inferSelect;
export type ScheduleView = {
  id: string;
  productId: string | null;
  product: { id: string; key: string; name: string } | null;
  name: string;
  cron: string;
  timezone: string;
  source: ScheduleSource;
  sourceConfig: Record<string, unknown>;
  channelIds: string[];
  channels: ChannelOption[];
  templateId: string | null;
  enabled: boolean;
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  lastSuccessAt: Date | null;
  consecutiveFailures: number;
  failThreshold: number;
  alertState: AlertState;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
};
export type NotificationScheduleInput = {
  productId: string;
  name: string;
  cron: string;
  timezone?: string;
  source: ScheduleSource;
  sourceConfig?: Record<string, unknown>;
  channelIds: string[];
  templateId?: string | null;
  enabled?: boolean;
  failThreshold?: number;
};
export type NotificationSchedulePatch = {
  name?: string;
  cron?: string;
  timezone?: string;
  sourceConfig?: Record<string, unknown>;
  channelIds?: string[];
  templateId?: string | null;
  enabled?: boolean;
  failThreshold?: number;
};

const NOT_FOUND = '定时推送不存在';

const SOURCE_CONFIG = {
  overview_card: z.object({ titlePrefix: z.string().trim().max(30).optional(), image: z.boolean().default(true) }).strict(),
  new_requirements: z
    .object({ emptyBehavior: z.enum(['skip', 'notice']).default('skip'), onlineSourceKeys: z.array(z.string().max(32)).max(20).default([]) })
    .strict(),
  digest: z.object({}).strict(),
};

export function parseSourceConfig(source: ScheduleSource, raw: unknown): Record<string, unknown> {
  const r = SOURCE_CONFIG[source].safeParse(raw ?? {});
  if (!r.success) throw new AppError('invalid', '内容来源的设置有误', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  return r.data as Record<string, unknown>;
}

function assertName(name: string): string {
  const v = name.trim();
  if (!v || v.length > 50) throw new AppError('invalid', '定时推送名称不能为空，且不超过 50 个字');
  return v;
}

function assertThreshold(v: number): number {
  if (!Number.isInteger(v) || v < 1 || v > 10) throw new AppError('invalid', '告警阈值应为 1–10 的整数');
  return v;
}

/** P3-A 的定时推送都属于某个产品，由该产品的管理员管理；没有产品的（以后的组织级来源）由组织管理员管理。 */
export async function requireScheduleAdminTx(tx: Tx, actor: Actor, productId: string | null): Promise<void> {
  if (productId) await requireProductRole(tx, actor, productId, 'admin');
  else requireOrgAdmin(actor);
}

export async function scheduleViewsTx(tx: Tx, rows: ScheduleRow[]): Promise<ScheduleView[]> {
  const channelIds = [...new Set(rows.flatMap((r) => r.channelIds))];
  const chans = channelIds.length ? await tx.select().from(notificationChannels).where(inArray(notificationChannels.id, channelIds)) : [];
  const productIds = [...new Set(rows.map((r) => r.productId).filter((x): x is string => !!x))];
  const prods = productIds.length ? await tx.select({ id: products.id, key: products.key, name: products.name }).from(products).where(inArray(products.id, productIds)) : [];
  return rows.map((r) => ({
    id: r.id,
    productId: r.productId,
    product: prods.find((p) => p.id === r.productId) ?? null,
    name: r.name,
    cron: r.cron,
    timezone: r.timezone,
    source: r.source,
    sourceConfig: r.sourceConfig,
    channelIds: r.channelIds,
    channels: r.channelIds.flatMap((id) => {
      const c = chans.find((x) => x.id === id);
      return c ? [channelOption(c)] : [];
    }),
    templateId: r.templateId,
    enabled: r.enabled,
    nextRunAt: r.nextRunAt,
    lastRunAt: r.lastRunAt,
    lastSuccessAt: r.lastSuccessAt,
    consecutiveFailures: r.consecutiveFailures,
    failThreshold: r.failThreshold,
    alertState: r.alertState,
    lastError: r.lastError,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

async function loadForUpdate(tx: Tx, id: string): Promise<ScheduleRow> {
  const [row] = await tx.select().from(notificationSchedules).where(eq(notificationSchedules.id, id)).for('no key update');
  if (!row) throw new AppError('not_found', NOT_FOUND);
  return row;
}

async function loadForDelete(tx: Tx, id: string): Promise<ScheduleRow> {
  const [row] = await tx.select().from(notificationSchedules).where(eq(notificationSchedules.id, id)).for('update');
  if (!row) throw new AppError('not_found', NOT_FOUND);
  return row;
}

export async function listSchedules(db: Db, actor: Actor, opts: { productId?: string } = {}): Promise<ScheduleView[]> {
  return withOrg(db, actor.orgId, async (tx) => {
    if (opts.productId) await requireProductRole(tx, actor, opts.productId, 'admin');
    else requireOrgAdmin(actor);
    const rows = await tx
      .select()
      .from(notificationSchedules)
      .where(opts.productId ? eq(notificationSchedules.productId, opts.productId) : undefined)
      .orderBy(asc(notificationSchedules.name));
    return scheduleViewsTx(tx, rows);
  });
}

export async function getSchedule(db: Db, actor: Actor, id: string): Promise<ScheduleView> {
  return withOrg(db, actor.orgId, async (tx) => {
    const [row] = await tx.select().from(notificationSchedules).where(eq(notificationSchedules.id, id));
    if (!row) throw new AppError('not_found', NOT_FOUND);
    await requireScheduleAdminTx(tx, actor, row.productId);
    return (await scheduleViewsTx(tx, [row]))[0]!;
  });
}

export async function createSchedule(db: Db, actor: Actor, input: NotificationScheduleInput, opts: { now?: Date } = {}): Promise<ScheduleView> {
  if (!input.productId) throw new AppError('invalid', '请选择产品');
  if (!(SCHEDULE_SOURCES as readonly string[]).includes(input.source)) throw new AppError('invalid', '内容来源无效');
  const name = assertName(input.name);
  const cron = assertCron(input.cron);
  const timezone = assertTimezone(input.timezone ?? SCHEDULE_DEFAULT_TIMEZONE);
  const sourceConfig = parseSourceConfig(input.source, input.sourceConfig);
  const failThreshold = assertThreshold(input.failThreshold ?? 1);
  const enabled = input.enabled ?? true;
  return withOrg(db, actor.orgId, async (tx) => {
    await requireScheduleAdminTx(tx, actor, input.productId);
    const channelIds = await assertUsableChannelsTx(tx, input.channelIds, input.productId, { min: 1 });
    const templateId = await assertTemplateIdTx(tx, input.templateId);
    const [row] = await tx
      .insert(notificationSchedules)
      .values({
        orgId: actor.orgId,
        productId: input.productId,
        name,
        cron,
        timezone,
        source: input.source,
        sourceConfig,
        channelIds,
        templateId,
        enabled,
        failThreshold,
        nextRunAt: enabled ? nextRunAt(cron, timezone, opts.now ?? new Date()) : null,
      })
      .returning();
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: input.productId,
      type: 'notification_schedule.created',
      subjectType: 'notification_schedule',
      subjectId: row!.id,
      actor,
      payload: { name, cron, timezone, source: input.source, sourceConfig, channelIds, templateId, enabled, failThreshold },
    });
    return (await scheduleViewsTx(tx, [row!]))[0]!;
  });
}

export async function updateSchedule(db: Db, actor: Actor, id: string, patch: NotificationSchedulePatch, opts: { now?: Date } = {}): Promise<ScheduleView> {
  return withOrg(db, actor.orgId, async (tx) => {
    const cur = await loadForUpdate(tx, id);
    await requireScheduleAdminTx(tx, actor, cur.productId);
    const next = {
      name: patch.name === undefined ? cur.name : assertName(patch.name),
      cron: patch.cron === undefined ? cur.cron : assertCron(patch.cron),
      timezone: patch.timezone === undefined ? cur.timezone : assertTimezone(patch.timezone),
      sourceConfig: patch.sourceConfig === undefined ? cur.sourceConfig : parseSourceConfig(cur.source, patch.sourceConfig),
      // 只在提交了通道时校验：迁移来的停用通道不妨碍修改其他字段
      channelIds: patch.channelIds === undefined ? cur.channelIds : await assertUsableChannelsTx(tx, patch.channelIds, cur.productId, { min: 1 }),
      templateId: patch.templateId === undefined ? cur.templateId : await assertTemplateIdTx(tx, patch.templateId),
      enabled: patch.enabled ?? cur.enabled,
      failThreshold: patch.failThreshold === undefined ? cur.failThreshold : assertThreshold(patch.failThreshold),
    };
    const changes = (Object.keys(next) as Array<keyof typeof next>)
      .filter((k) => JSON.stringify(next[k]) !== JSON.stringify(cur[k]))
      .map((k) => ({ field: k, old: cur[k], new: next[k] }));
    if (changes.length === 0) return (await scheduleViewsTx(tx, [cur]))[0]!;
    const timing = next.cron !== cur.cron || next.timezone !== cur.timezone || next.enabled !== cur.enabled;
    const [row] = await tx
      .update(notificationSchedules)
      .set({
        ...next,
        ...(timing ? { nextRunAt: next.enabled ? nextRunAt(next.cron, next.timezone, opts.now ?? new Date()) : null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(notificationSchedules.id, id))
      .returning();
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: cur.productId,
      type: 'notification_schedule.updated',
      subjectType: 'notification_schedule',
      subjectId: id,
      actor,
      payload: { changes },
    });
    return (await scheduleViewsTx(tx, [row!]))[0]!;
  });
}

export async function deleteSchedule(db: Db, actor: Actor, id: string): Promise<void> {
  return withOrg(db, actor.orgId, async (tx) => {
    const cur = await loadForDelete(tx, id);
    await requireScheduleAdminTx(tx, actor, cur.productId);
    const [delivery] = await tx.select({ id: notificationDeliveries.id }).from(notificationDeliveries).where(eq(notificationDeliveries.scheduleId, id)).limit(1);
    if (delivery) throw new AppError('conflict', '已有发送记录的定时推送只能停用');
    const [rule] = await tx.select({ id: notificationRules.id }).from(notificationRules).where(eq(notificationRules.digestScheduleId, id)).limit(1);
    if (rule) throw new AppError('conflict', '有摘要规则使用该定时推送，先修改或删除这些规则');
    // 规则改用其他定时推送后，这里可能还留有未发送的摘要条目，随定时推送一起删除
    await tx.delete(notificationDigestItems).where(and(eq(notificationDigestItems.scheduleId, id), isNull(notificationDigestItems.consumedAt)));
    await tx.delete(notificationSchedules).where(eq(notificationSchedules.id, id));
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: cur.productId,
      type: 'notification_schedule.deleted',
      subjectType: 'notification_schedule',
      subjectId: id,
      actor,
      payload: { name: cur.name, source: cur.source },
    });
  });
}
