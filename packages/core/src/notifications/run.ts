import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { notificationDeliveries, notificationDigestItems, notificationSchedules, products } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import { newId } from '../ids';
import { usableChannelsTx } from './channels';
import type { ChannelPayload, NewRequirementsConfig, OverviewCardConfig } from './constants';
import { renderDashboardPng, wecomImagePayload } from './dashboard-image';
import { resolveTemplateTx } from './message-templates';
import { parseSourceConfig, requireScheduleAdminTx, type ScheduleRow } from './schedules';
import { digestDataTx, newRequirementsDataTx, orgContextTx, overviewDataTx, shortDate } from './sources';
import { type RenderedMessage, renderMessage, toChannelPayloads } from './template';

/** imageSkipped：概览卡片要附带看板图片、但这次没有发图片的原因（只发了卡片）。 */
export type RunResult = { runId: string | null; deliveries: number; skipped: string | null; imageSkipped: string | null };

const DIGEST_BATCH = 200;
export const NO_CHANNEL = '没有可用的通道（通道已停用、已删除或不允许本产品使用）';

/** 同一定时推送同时只能有一处在执行（多实例互斥）；拿不到锁返回 false。 */
export async function tryScheduleLockTx(tx: Tx, scheduleId: string): Promise<boolean> {
  const [row] = (await tx.execute(sql`select pg_try_advisory_xact_lock(hashtextextended(${`flower:notify-schedule:${scheduleId}`}, 0)) as locked`)) as unknown as [{ locked: boolean }];
  return row!.locked;
}

/** 看板图片的请求体；生成失败或超过上限时返回原因，不让整次执行失败。 */
async function dashboardImageOf(dashboard: Parameters<typeof renderDashboardPng>[0]): Promise<{ payload: ChannelPayload } | { skipped: string }> {
  try {
    return wecomImagePayload(await renderDashboardPng(dashboard));
  } catch (e) {
    return { skipped: `生成失败：${e instanceof Error ? e.message : String(e)}`.slice(0, 200) };
  }
}

/**
 * 生成一次执行的内容：按来源取数、用模板渲染、为每个可用通道写待发记录（同一个 run_id），
 * 更新 last_run_at 与 last_error。不改 next_run_at（由后台循环或调用方决定）。
 * 概览卡片开启「附带看板图片」（缺省为开启）时，每个企微通道先写一条图片、再写卡片；
 * 图片没有生成时只发卡片，原因记入结果与 last_error。
 */
export async function generateScheduleRunTx(tx: Tx, s: ScheduleRow, deps: { publicUrl: string }, now: Date): Promise<RunResult> {
  const skip = async (reason: string, isError: boolean): Promise<RunResult> => {
    await tx.update(notificationSchedules).set({ lastRunAt: now, lastError: isError ? reason : null, updatedAt: now }).where(eq(notificationSchedules.id, s.id));
    return { runId: null, deliveries: 0, skipped: reason, imageSkipped: null };
  };
  if (!s.productId) return skip('定时推送没有指定产品', true);
  const channels = await usableChannelsTx(tx, s.channelIds, s.productId, { lock: true });
  if (channels.length === 0) return skip(NO_CHANNEL, true);
  const ctx = await orgContextTx(tx, s.orgId, deps.publicUrl);
  const tpl = await resolveTemplateTx(tx, s.templateId, s.source);
  const runId = newId();
  let messages: RenderedMessage[];
  let image: ChannelPayload | null = null;
  let imageSkipped: string | null = null;
  if (s.source === 'overview_card') {
    const wantImage = (s.sourceConfig as OverviewCardConfig).image !== false && channels.some((c) => c.kind === 'wecom_robot');
    const { card, dashboard } = await overviewDataTx(tx, s, ctx, now, { dashboard: wantImage });
    messages = [renderMessage(tpl.format, tpl.body, card)];
    if (dashboard) {
      const r = await dashboardImageOf(dashboard);
      if ('payload' in r) image = r.payload;
      else imageSkipped = r.skipped;
    }
  } else if (s.source === 'new_requirements') {
    const data = await newRequirementsDataTx(tx, s, ctx, now);
    if (data) messages = [renderMessage(tpl.format, tpl.body, data)];
    else {
      const cfg = parseSourceConfig('new_requirements', s.sourceConfig) as NewRequirementsConfig;
      if (cfg.emptyBehavior !== 'notice') return skip('没有新需求', false);
      const [p] = await tx.select({ name: products.name }).from(products).where(eq(products.id, s.productId));
      messages = [{ format: 'text', text: `${p?.name ?? ''} ${shortDate(now, s.timezone)} 没有新需求` }];
    }
  } else {
    const open = tx
      .select({ id: notificationDigestItems.id })
      .from(notificationDigestItems)
      .where(and(eq(notificationDigestItems.scheduleId, s.id), isNull(notificationDigestItems.consumedAt), isNull(notificationDigestItems.runId)))
      .orderBy(asc(notificationDigestItems.createdAt))
      .limit(DIGEST_BATCH);
    const items = await tx
      .update(notificationDigestItems)
      .set({ runId })
      .where(and(inArray(notificationDigestItems.id, open), isNull(notificationDigestItems.runId)))
      .returning({ eventId: notificationDigestItems.eventId, createdAt: notificationDigestItems.createdAt });
    if (items.length === 0) return skip('没有待合并的变化', false);
    messages = [renderMessage(tpl.format, tpl.body, await digestDataTx(tx, s, items, ctx, now))];
  }
  // 同一次的记录 created_at 相同，发送按 (created_at, id) 的顺序；id 按写入顺序生成（uuidv7 递增），图片排在卡片之前
  const rows = channels.flatMap((c) =>
    [...(image && c.kind === 'wecom_robot' ? [image] : []), ...messages.flatMap((m) => toChannelPayloads(c.kind, m))].map((payload) => ({
      id: newId(),
      orgId: s.orgId,
      kind: 'schedule' as const,
      scheduleId: s.id,
      runId,
      channelId: c.id,
      payload,
      status: 'pending' as const,
      nextAttemptAt: now,
      createdAt: now,
    })),
  );
  await tx.insert(notificationDeliveries).values(rows);
  const lastError = imageSkipped ? `看板图片未发送：${imageSkipped}` : null;
  await tx.update(notificationSchedules).set({ lastRunAt: now, lastError, updatedAt: now }).where(eq(notificationSchedules.id, s.id));
  return { runId, deliveries: rows.length, skipped: null, imageSkipped };
}

/** 立即执行：只生成待发记录，由后台循环发送；不改 next_run_at。 */
export async function runScheduleNow(db: Db, actor: Actor, id: string, deps: { publicUrl: string }, opts: { now?: Date } = {}): Promise<RunResult> {
  return withOrg(db, actor.orgId, async (tx) => {
    const [cur] = await tx.select().from(notificationSchedules).where(eq(notificationSchedules.id, id));
    if (!cur) throw new AppError('not_found', '定时推送不存在');
    await requireScheduleAdminTx(tx, actor, cur.productId);
    if (!(await tryScheduleLockTx(tx, id))) throw new AppError('conflict', '该定时推送正在执行，请稍后再试');
    const [fresh] = await tx.select().from(notificationSchedules).where(eq(notificationSchedules.id, id)).for('no key update');
    if (!fresh) throw new AppError('not_found', '定时推送不存在');
    const result = await generateScheduleRunTx(tx, fresh, deps, opts.now ?? new Date());
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: cur.productId,
      type: 'notification_schedule.run',
      subjectType: 'notification_schedule',
      subjectId: id,
      actor,
      payload: { manual: true, deliveries: result.deliveries, skipped: result.skipped },
    });
    return result;
  });
}
