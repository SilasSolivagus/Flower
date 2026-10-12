import { and, arrayContains, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { requireOrgAdmin, requireProductRole } from '../access/permissions';
import type { Db } from '../db/client';
import { notificationChannels, notificationDeliveries, notificationRules, notificationSchedules, products } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError, isUniqueViolation } from '../errors';
import { recordEvent } from '../events';
import {
  type ChannelConfig,
  type ChannelConfigPatch,
  type ChannelPublicSettings,
  channelConfigHint,
  channelPublicSettings,
  mergeChannelConfig,
  parseChannelConfig,
} from './channel-config';
import { CHANNEL_KINDS, type ChannelKind, DEFAULT_RATE_LIMIT } from './constants';
import { decryptConfig, encryptConfig } from './secrets';

export type SecretDeps = { secretKey: string };
export type ChannelRow = typeof notificationChannels.$inferSelect;
export type ChannelView = {
  id: string;
  kind: ChannelKind;
  name: string;
  groupLabel: string | null;
  configHint: string;
  settings: ChannelPublicSettings;
  rateLimitPerMin: number;
  allowedProductIds: string[];
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  usage: { rules: number; schedules: number; deliveries: number };
};
export type ChannelOption = { id: string; kind: ChannelKind; name: string; groupLabel: string | null; enabled: boolean };
export type ChannelInput = {
  kind: ChannelKind;
  name: string;
  groupLabel?: string | null;
  config: unknown;
  rateLimitPerMin?: number;
  allowedProductIds?: string[];
  enabled?: boolean;
};
export type ChannelPatch = {
  name?: string;
  groupLabel?: string | null;
  config?: ChannelConfigPatch;
  rateLimitPerMin?: number;
  allowedProductIds?: string[];
  enabled?: boolean;
};

const NOT_FOUND = '通道不存在';
const UNUSABLE = '通道不存在、已停用或不允许本产品使用';

function assertName(name: string): string {
  const v = name.trim();
  if (!v || v.length > 50) throw new AppError('invalid', '通道名称不能为空，且不超过 50 个字');
  return v;
}

function assertGroupLabel(value: string | null | undefined): string | null {
  const v = value?.trim() ?? '';
  if (v.length > 50) throw new AppError('invalid', '所属群不超过 50 个字');
  return v || null;
}

function assertRate(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 600) throw new AppError('invalid', '每分钟发送上限应为 1–600 的整数');
  return value;
}

async function assertProducts(tx: Tx, ids: string[]): Promise<string[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const found = await tx.select({ id: products.id }).from(products).where(and(inArray(products.id, unique), isNull(products.deletedAt)));
  if (found.length !== unique.length) throw new AppError('invalid', '可用产品中有不存在的产品');
  return unique;
}

export function readChannelConfig(row: ChannelRow, secretKey: string): ChannelConfig {
  return decryptConfig<ChannelConfig>(row.config, secretKey);
}

export const channelOption = (r: ChannelRow): ChannelOption => ({ id: r.id, kind: r.kind, name: r.name, groupLabel: r.groupLabel, enabled: r.enabled });

async function viewsTx(tx: Tx, rows: ChannelRow[], secretKey: string): Promise<ChannelView[]> {
  if (rows.length === 0) return [];
  const ruleRows = await tx.select({ ids: notificationRules.channelIds }).from(notificationRules);
  const scheduleRows = await tx.select({ ids: notificationSchedules.channelIds }).from(notificationSchedules);
  const deliveryCounts = await tx
    .select({ id: notificationDeliveries.channelId, n: sql<number>`count(*)::int` })
    .from(notificationDeliveries)
    .where(inArray(notificationDeliveries.channelId, rows.map((r) => r.id)))
    .groupBy(notificationDeliveries.channelId);
  const refs = (list: Array<{ ids: string[] }>, id: string) => list.filter((r) => r.ids.includes(id)).length;
  return rows.map((r) => {
    let settings: ChannelPublicSettings = null;
    if (r.kind === 'email') {
      try {
        settings = channelPublicSettings(r.kind, readChannelConfig(r, secretKey));
      } catch {
        settings = null;
      }
    }
    return {
      id: r.id,
      kind: r.kind,
      name: r.name,
      groupLabel: r.groupLabel,
      configHint: r.configHint,
      settings,
      rateLimitPerMin: r.rateLimitPerMin,
      allowedProductIds: r.allowedProductIds,
      enabled: r.enabled,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      usage: { rules: refs(ruleRows, r.id), schedules: refs(scheduleRows, r.id), deliveries: deliveryCounts.find((d) => d.id === r.id)?.n ?? 0 },
    };
  });
}

export async function listChannels(db: Db, actor: Actor, deps: SecretDeps): Promise<ChannelView[]> {
  requireOrgAdmin(actor);
  return withOrg(db, actor.orgId, async (tx) => {
    const rows = await tx.select().from(notificationChannels).orderBy(asc(notificationChannels.groupLabel), asc(notificationChannels.name));
    return viewsTx(tx, rows, deps.secretKey);
  });
}

export async function createChannel(db: Db, actor: Actor, input: ChannelInput, deps: SecretDeps): Promise<ChannelView> {
  requireOrgAdmin(actor);
  if (!(CHANNEL_KINDS as readonly string[]).includes(input.kind)) throw new AppError('invalid', '通道类型无效');
  const name = assertName(input.name);
  const groupLabel = assertGroupLabel(input.groupLabel);
  const config = parseChannelConfig(input.kind, input.config);
  const rateLimitPerMin = assertRate(input.rateLimitPerMin ?? DEFAULT_RATE_LIMIT[input.kind]);
  return withOrg(db, actor.orgId, async (tx) => {
    const allowedProductIds = await assertProducts(tx, input.allowedProductIds ?? []);
    const configHint = channelConfigHint(input.kind, config);
    let row: ChannelRow;
    try {
      [row] = (await tx
        .insert(notificationChannels)
        .values({
          orgId: actor.orgId,
          kind: input.kind,
          name,
          groupLabel,
          config: encryptConfig(config, deps.secretKey),
          configHint,
          rateLimitPerMin,
          allowedProductIds,
          enabled: input.enabled ?? true,
        })
        .returning()) as [ChannelRow];
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppError('conflict', '通道名称已存在');
      throw e;
    }
    await recordEvent(tx, {
      orgId: actor.orgId,
      type: 'notification_channel.created',
      subjectType: 'notification_channel',
      subjectId: row.id,
      actor,
      payload: { kind: row.kind, name, groupLabel, configHint, rateLimitPerMin, allowedProductIds, enabled: row.enabled },
    });
    return (await viewsTx(tx, [row], deps.secretKey))[0]!;
  });
}

export async function updateChannel(db: Db, actor: Actor, id: string, patch: ChannelPatch, deps: SecretDeps): Promise<ChannelView> {
  requireOrgAdmin(actor);
  return withOrg(db, actor.orgId, async (tx) => {
    const [cur] = await tx.select().from(notificationChannels).where(eq(notificationChannels.id, id)).for('no key update');
    if (!cur) throw new AppError('not_found', NOT_FOUND);
    const set: Partial<typeof notificationChannels.$inferInsert> = {};
    const changes: Array<{ field: string; old: unknown; new: unknown }> = [];
    if (patch.name !== undefined) {
      const v = assertName(patch.name);
      if (v !== cur.name) {
        set.name = v;
        changes.push({ field: 'name', old: cur.name, new: v });
      }
    }
    if (patch.groupLabel !== undefined) {
      const v = assertGroupLabel(patch.groupLabel);
      if (v !== cur.groupLabel) {
        set.groupLabel = v;
        changes.push({ field: 'groupLabel', old: cur.groupLabel, new: v });
      }
    }
    if (patch.rateLimitPerMin !== undefined) {
      const v = assertRate(patch.rateLimitPerMin);
      if (v !== cur.rateLimitPerMin) {
        set.rateLimitPerMin = v;
        changes.push({ field: 'rateLimitPerMin', old: cur.rateLimitPerMin, new: v });
      }
    }
    if (patch.allowedProductIds !== undefined) {
      const v = await assertProducts(tx, patch.allowedProductIds);
      if ([...v].sort().join() !== [...cur.allowedProductIds].sort().join()) {
        set.allowedProductIds = v;
        changes.push({ field: 'allowedProductIds', old: cur.allowedProductIds, new: v });
      }
    }
    if (patch.enabled !== undefined && patch.enabled !== cur.enabled) {
      set.enabled = patch.enabled;
      changes.push({ field: 'enabled', old: cur.enabled, new: patch.enabled });
    }
    if (patch.config !== undefined) {
      const before = readChannelConfig(cur, deps.secretKey);
      const next = mergeChannelConfig(cur.kind, before, patch.config);
      if (JSON.stringify(next) !== JSON.stringify(before)) {
        const hint = channelConfigHint(cur.kind, next);
        set.config = encryptConfig(next, deps.secretKey);
        set.configHint = hint;
        // 只记脱敏提示，不记明文
        changes.push({ field: 'config', old: cur.configHint, new: hint });
      }
    }
    if (changes.length === 0) return (await viewsTx(tx, [cur], deps.secretKey))[0]!;
    let row: ChannelRow;
    try {
      [row] = (await tx
        .update(notificationChannels)
        .set({ ...set, updatedAt: new Date() })
        .where(eq(notificationChannels.id, id))
        .returning()) as [ChannelRow];
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppError('conflict', '通道名称已存在');
      throw e;
    }
    await recordEvent(tx, { orgId: actor.orgId, type: 'notification_channel.updated', subjectType: 'notification_channel', subjectId: id, actor, payload: { changes } });
    return (await viewsTx(tx, [row], deps.secretKey))[0]!;
  });
}

export async function deleteChannel(db: Db, actor: Actor, id: string): Promise<void> {
  requireOrgAdmin(actor);
  return withOrg(db, actor.orgId, async (tx) => {
    const [cur] = await tx.select().from(notificationChannels).where(eq(notificationChannels.id, id)).for('update');
    if (!cur) throw new AppError('not_found', NOT_FOUND);
    const [delivery] = await tx.select({ id: notificationDeliveries.id }).from(notificationDeliveries).where(eq(notificationDeliveries.channelId, id)).limit(1);
    const [rule] = await tx.select({ id: notificationRules.id }).from(notificationRules).where(arrayContains(notificationRules.channelIds, [id])).limit(1);
    const [schedule] = await tx.select({ id: notificationSchedules.id }).from(notificationSchedules).where(arrayContains(notificationSchedules.channelIds, [id])).limit(1);
    if (delivery || rule || schedule) throw new AppError('conflict', '已有发送记录或被规则、定时推送引用的通道只能停用');
    await tx.delete(notificationChannels).where(eq(notificationChannels.id, id));
    await recordEvent(tx, { orgId: actor.orgId, type: 'notification_channel.deleted', subjectType: 'notification_channel', subjectId: id, actor, payload: { name: cur.name, kind: cur.kind } });
  });
}

/**
 * 启用、且对该产品可用（allowed_product_ids 为空或包含该产品）的通道；ids 为 null 时不限通道。
 * `lock` 时对读到的通道加 FOR KEY SHARE，与删除通道的 FOR UPDATE 串行，避免随后插入的发送记录外键失效。
 */
export async function usableChannelsTx(tx: Tx, ids: string[] | null, productId: string | null, opts: { lock?: boolean } = {}): Promise<ChannelRow[]> {
  if (ids !== null && ids.length === 0) return [];
  const q = tx
    .select()
    .from(notificationChannels)
    .where(and(eq(notificationChannels.enabled, true), ids === null ? undefined : inArray(notificationChannels.id, ids)))
    .orderBy(asc(notificationChannels.name));
  const rows = opts.lock ? await q.for('key share') : await q;
  return rows.filter((r) => r.allowedProductIds.length === 0 || (productId !== null && r.allowedProductIds.includes(productId)));
}

/** 规则与定时推送选择的通道：去重后 min–10 个，全部启用且对该产品可用。 */
export async function assertUsableChannelsTx(tx: Tx, ids: string[], productId: string | null, opts: { min: number }): Promise<string[]> {
  const unique = [...new Set(ids)];
  if (unique.length < opts.min || unique.length > 10) throw new AppError('invalid', opts.min > 0 ? '请选择 1–10 个通道' : '最多选择 10 个通道');
  const usable = await usableChannelsTx(tx, unique, productId);
  if (usable.length !== unique.length) throw new AppError('invalid', UNUSABLE);
  return unique;
}

export async function listProductChannelOptions(db: Db, actor: Actor, productId: string): Promise<ChannelOption[]> {
  return withOrg(db, actor.orgId, async (tx) => {
    await requireProductRole(tx, actor, productId, 'admin');
    return (await usableChannelsTx(tx, null, productId)).map(channelOption);
  });
}
