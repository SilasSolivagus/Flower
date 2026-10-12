import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, or, type SQL, sql } from 'drizzle-orm';
import { requireOrgAdmin } from '../access/permissions';
import type { Db } from '../db/client';
import { notificationChannels, notificationDeliveries, notificationDigestItems, notificationRules, notificationSchedules } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import type { ChannelConfig } from './channel-config';
import { type ChannelRow, readChannelConfig } from './channels';
import { type ChannelKind, type ChannelPayload, type DeliveryKind, type DeliveryStatus, RESPONSE_MAX_CHARS } from './constants';
import { resolveTemplateTx } from './message-templates';
import { type NotifyDeps, retryDelayMs, type SendOutcome, sendPayload } from './sender';
import { eventMessageDataTx, formatMinute, orgContextTx } from './sources';
import { payloadPreview, renderMessage, TRUNCATED_MARK, toChannelPayloads, truncateBytes, WECOM_MARKDOWN_MAX_BYTES } from './template';

export type DeliveryRow = typeof notificationDeliveries.$inferSelect;
export type DeliveryView = {
  id: string;
  kind: DeliveryKind;
  source: { type: DeliveryKind; id: string | null; name: string | null; alert: boolean };
  channel: { id: string; name: string; kind: ChannelKind };
  eventId: string | null;
  status: DeliveryStatus;
  attempts: number;
  nextAttemptAt: Date | null;
  response: string | null;
  sentAt: Date | null;
  createdAt: Date;
  preview: string;
  legacy: boolean;
  canResend: boolean;
};
export type DeliveryQuery = { channelId?: string; kind?: DeliveryKind; status?: DeliveryStatus; from?: Date; to?: Date; before?: string; limit?: number };
export type ProcessSummary = { sent: number; failed: number; dead: number; rateLimited: number };

const BATCH = 50;
/**
 * 发送中的租约：基础时间加上排在它前面（含自己）每条的发送余量。一轮取到的记录在事务外逐条发送，
 * 排在后面的记录要等前面的发完，租约按位置递增，保证在正常超时内发完之前不会被其他实例回收重发。
 */
const LEASE_BASE_MS = 60_000;
/** 一轮领取的发送余量合计上限：租约（基础 + 余量）不超过 5 分钟，超出的留给下一轮（至少领取一条）。 */
const MAX_ALLOWANCE_MS = 240_000;
/** 每条的发送余量：HTTP 超时 10 秒；SMTP 连接、问候各 10 秒，收发静默 20 秒。 */
const SEND_ALLOWANCE_MS: Record<ChannelKind, number> = { wecom_robot: 15_000, webhook: 15_000, email: 60_000 };
const RATE_WINDOW_MS = 60_000;
const NOT_FOUND = '发送记录不存在';
const INTERRUPTED = '发送中断（进程退出或超时），按失败处理';

/** drizzle 的查询错误把 SQL 与参数写进 message，只取底层原因。 */
const errorText = (e: unknown): string => {
  const cause = e instanceof Error && e.cause instanceof Error ? e.cause : e;
  return (cause instanceof Error ? cause.message : String(cause)).slice(0, RESPONSE_MAX_CHARS);
};

/**
 * 写入时刻：当前时钟，但不早于调用方给的 now。租约、发送时间、重试与限流的下次时间都按写入时的实际时间算，
 * 前面的记录发送耗时不会让后面的时间提前到期；测试传入未来的 now 模拟时间时结果仍可预期。
 */
const clockAfter = (now: Date): Date => new Date(Math.max(now.getTime(), Date.now()));

async function tryChannelLockTx(tx: Tx, channelId: string): Promise<boolean> {
  const [row] = (await tx.execute(sql`select pg_try_advisory_xact_lock(hashtextextended(${`flower:notify-channel:${channelId}`}, 0)) as locked`)) as unknown as [{ locked: boolean }];
  return row!.locked;
}

/**
 * 定时推送一次执行的结果：任一条成功 → 清零、解除告警、记 last_success_at（执行时间）、摘要条目已消费；
 * 同一次的记录全部放弃 → 连续失败加一、达到阈值告警、摘要条目释放。
 * 先锁定时推送行：同一次执行的几条记录在不同事务里结束时，按顺序判断「是否全部放弃」。
 */
async function settleRunTx(tx: Tx, d: DeliveryRow, now: Date, outcome: 'sent' | 'dead'): Promise<void> {
  if (!d.runId || !d.scheduleId) return;
  const [s] = await tx.select().from(notificationSchedules).where(eq(notificationSchedules.id, d.scheduleId)).for('no key update');
  if (!s) return;
  if (outcome === 'sent') {
    const runAt = sql`${d.createdAt.toISOString()}::timestamptz`;
    await tx
      .update(notificationSchedules)
      .set({ consecutiveFailures: 0, alertState: 'normal', lastSuccessAt: sql`greatest(coalesce(${notificationSchedules.lastSuccessAt}, ${runAt}), ${runAt})`, updatedAt: now })
      .where(eq(notificationSchedules.id, s.id));
    await tx.update(notificationDigestItems).set({ consumedAt: now }).where(and(eq(notificationDigestItems.runId, d.runId), isNull(notificationDigestItems.consumedAt)));
    return;
  }
  const [open] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(notificationDeliveries)
    .where(and(eq(notificationDeliveries.runId, d.runId), sql`${notificationDeliveries.status} <> 'dead'`));
  if (open!.n > 0) return;
  const failures = s.consecutiveFailures + 1;
  await tx
    .update(notificationSchedules)
    .set({ consecutiveFailures: failures, alertState: failures >= s.failThreshold ? 'alert' : s.alertState, updatedAt: now })
    .where(eq(notificationSchedules.id, s.id));
  await tx.update(notificationDigestItems).set({ runId: null }).where(and(eq(notificationDigestItems.runId, d.runId), isNull(notificationDigestItems.consumedAt)));
}

async function markDeadTx(tx: Tx, d: DeliveryRow, response: string, now: Date): Promise<void> {
  await tx.update(notificationDeliveries).set({ status: 'dead', nextAttemptAt: null, response }).where(eq(notificationDeliveries.id, d.id));
  await settleRunTx(tx, d, now, 'dead');
}

type FinalizeResult = 'sent' | 'failed' | 'dead' | 'rate_limited' | 'skipped';

/**
 * 写入一次发送（或渲染）的结果。guard 限定要更新的行：本事务已锁住的行只按 id；
 * 事务外发送完的行还要求仍是本实例的租约（status = sending 且租约时间未变），已被回收的跳过。
 */
async function finalizeTx(tx: Tx, d: DeliveryRow, outcome: SendOutcome, now: Date, guard: SQL | undefined): Promise<FinalizeResult> {
  const response = outcome.response.slice(0, RESPONSE_MAX_CHARS);
  const apply = async (set: Partial<typeof notificationDeliveries.$inferInsert>) =>
    (await tx.update(notificationDeliveries).set({ ...set, response }).where(guard).returning({ id: notificationDeliveries.id })).length > 0;
  if (outcome.result === 'sent') {
    if (!(await apply({ status: 'sent', attempts: d.attempts + 1, sentAt: now, nextAttemptAt: null }))) return 'skipped';
    await settleRunTx(tx, d, now, 'sent');
    return 'sent';
  }
  if (outcome.result === 'rate_limited') {
    return (await apply({ status: 'pending', nextAttemptAt: new Date(now.getTime() + RATE_WINDOW_MS) })) ? 'rate_limited' : 'skipped';
  }
  const attempts = d.attempts + 1;
  const delay = d.kind === 'test' ? null : retryDelayMs(attempts);
  if (delay === null) {
    if (!(await apply({ status: 'dead', attempts, nextAttemptAt: null }))) return 'skipped';
    await settleRunTx(tx, d, now, 'dead');
    return 'dead';
  }
  return (await apply({ status: 'failed', attempts, nextAttemptAt: new Date(now.getTime() + delay) })) ? 'failed' : 'skipped';
}

/**
 * 事件规则的记录：用规则的模板（或预置「事件推送」）渲染，只发一条。
 * 企微 markdown 超过单条上限时截断并注明，不拆成多条。
 */
async function renderRuleDeliveryTx(tx: Tx, d: DeliveryRow, channel: ChannelRow, deps: { publicUrl: string }): Promise<ChannelPayload> {
  if (!d.eventId) throw new AppError('invalid', '记录缺少事件');
  const [rule] = d.ruleId ? await tx.select({ templateId: notificationRules.templateId }).from(notificationRules).where(eq(notificationRules.id, d.ruleId)) : [];
  const tpl = await resolveTemplateTx(tx, rule?.templateId ?? null, 'event');
  const data = await eventMessageDataTx(tx, d.eventId, await orgContextTx(tx, d.orgId, deps.publicUrl));
  const msg = renderMessage(tpl.format, tpl.body, data);
  if (channel.kind === 'wecom_robot' && (msg.format === 'markdown' || msg.format === 'markdown_v2')) msg.text = truncateBytes(msg.text, WECOM_MARKDOWN_MAX_BYTES, TRUNCATED_MARK);
  return toChannelPayloads(channel.kind, msg)[0]!;
}

/** 记录所属的产品：事件规则或定时推送的产品；都没有时为 null。 */
async function deliveryProductIdTx(tx: Tx, d: DeliveryRow): Promise<string | null> {
  if (d.ruleId) {
    const [r] = await tx.select({ productId: notificationRules.productId }).from(notificationRules).where(eq(notificationRules.id, d.ruleId));
    return r?.productId ?? null;
  }
  if (d.scheduleId) {
    const [s] = await tx.select({ productId: notificationSchedules.productId }).from(notificationSchedules).where(eq(notificationSchedules.id, d.scheduleId));
    return s?.productId ?? null;
  }
  return null;
}

/**
 * 处理一个组织到期的发送记录：回收租约到期的发送中记录；取到期的待发与待重试记录（SKIP LOCKED），
 * 按通道加锁、按每分钟上限取余量（超出的推到窗口之后），改为发送中后提交；在事务外逐条发送，
 * 每条结果在新事务里写入。onlyIds（测试消息）只处理指定的待发记录，不回收其他记录。
 */
export async function processDueDeliveries(db: Db, orgId: string, deps: NotifyDeps, now: Date, opts: { onlyIds?: string[] } = {}): Promise<ProcessSummary> {
  const summary: ProcessSummary = { sent: 0, failed: 0, dead: 0, rateLimited: 0 };
  const tally = (r: FinalizeResult) => {
    if (r === 'sent') summary.sent++;
    else if (r === 'failed') summary.failed++;
    else if (r === 'dead') summary.dead++;
    else if (r === 'rate_limited') summary.rateLimited++;
  };
  const D = notificationDeliveries;
  const claimed = await withOrg(db, orgId, async (tx) => {
    const claimAt = clockAfter(now);
    if (!opts.onlyIds) {
      const expired = await tx
        .select()
        .from(D)
        .where(and(eq(D.status, 'sending'), lte(D.nextAttemptAt, now)))
        .limit(BATCH)
        .for('no key update', { skipLocked: true });
      for (const d of expired) tally(await finalizeTx(tx, d, { result: 'failed', response: INTERRUPTED }, claimAt, eq(D.id, d.id)));
    }
    const due = await tx
      .select()
      .from(D)
      .where(and(inArray(D.status, ['pending', 'failed']), lte(D.nextAttemptAt, now), opts.onlyIds ? inArray(D.id, opts.onlyIds) : undefined))
      .orderBy(asc(D.nextAttemptAt), asc(D.createdAt), asc(D.id))
      .limit(BATCH)
      .for('no key update', { skipLocked: true });
    const byChannel = new Map<string, DeliveryRow[]>();
    for (const d of due) byChannel.set(d.channelId, [...(byChannel.get(d.channelId) ?? []), d]);
    const out: Array<{ d: DeliveryRow; channel: ChannelRow }> = [];
    let allowanceMs = 0;
    let full = false;
    for (const [channelId, list] of byChannel) {
      if (full) break;
      const [channel] = await tx.select().from(notificationChannels).where(eq(notificationChannels.id, channelId));
      if (!channel || !channel.enabled) {
        for (const d of list) {
          await markDeadTx(tx, d, '通道已停用，未发送', claimAt);
          summary.dead++;
        }
        continue;
      }
      // 通道的可用产品可能在记录生成后收窄：不再允许的记录直接放弃（测试消息不属于产品，不受限制）
      const sendable: DeliveryRow[] = [];
      for (const d of list) {
        const allowed =
          d.kind === 'test' || channel.allowedProductIds.length === 0 || channel.allowedProductIds.includes((await deliveryProductIdTx(tx, d)) ?? '');
        if (allowed) sendable.push(d);
        else {
          await markDeadTx(tx, d, '通道不再允许本产品使用，未发送', claimAt);
          summary.dead++;
        }
      }
      if (!(await tryChannelLockTx(tx, channelId))) continue;
      const [used] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(D)
        .where(and(eq(D.channelId, channelId), or(and(eq(D.status, 'sent'), gt(D.sentAt, new Date(claimAt.getTime() - RATE_WINDOW_MS))), eq(D.status, 'sending'))));
      const quota = Math.max(0, channel.rateLimitPerMin - used!.n);
      // 超出每分钟上限的推到窗口之后，不占下一轮的取数名额，其他通道的记录不会被挤掉
      const over = sendable.slice(quota).map((d) => d.id);
      if (over.length) {
        await tx.update(D).set({ nextAttemptAt: new Date(claimAt.getTime() + RATE_WINDOW_MS) }).where(inArray(D.id, over));
        summary.rateLimited += over.length;
      }
      for (const d of sendable.slice(0, quota)) {
        // 余量用完就停止领取（跨通道）；未领取的行不改动，事务结束后释放行锁，下一轮再取
        if (out.length > 0 && allowanceMs + SEND_ALLOWANCE_MS[channel.kind] > MAX_ALLOWANCE_MS) {
          full = true;
          break;
        }
        let payload = d.payload;
        if (!payload) {
          try {
            // 每条在自己的 savepoint 里渲染：查询出错只回滚这一条，本轮其余记录照常处理
            payload = await tx.transaction((sp) => renderRuleDeliveryTx(sp, d, channel, deps));
          } catch (e) {
            // 渲染错误是确定性的，重试也一样，直接放弃
            await markDeadTx(tx, d, `渲染失败：${errorText(e)}`.slice(0, RESPONSE_MAX_CHARS), claimAt);
            summary.dead++;
            continue;
          }
        }
        allowanceMs += SEND_ALLOWANCE_MS[channel.kind];
        const lease = new Date(claimAt.getTime() + LEASE_BASE_MS + allowanceMs);
        await tx.update(D).set({ status: 'sending', payload, nextAttemptAt: lease }).where(eq(D.id, d.id));
        out.push({ d: { ...d, status: 'sending', payload, nextAttemptAt: lease }, channel });
      }
    }
    return out;
  });
  const configs = new Map<string, ChannelConfig>();
  for (const { d, channel } of claimed) {
    let outcome: SendOutcome;
    if (d.payload!.type === 'legacy') outcome = { result: 'failed', response: '迁移来的历史记录不能发送' };
    else {
      try {
        const config = configs.get(channel.id) ?? readChannelConfig(channel, deps.secretKey);
        configs.set(channel.id, config);
        outcome = await sendPayload(channel.kind, config, d.payload as ChannelPayload, deps.transport, clockAfter(now));
      } catch (e) {
        outcome = { result: 'failed', response: errorText(e) };
      }
    }
    const mine = and(eq(D.id, d.id), eq(D.status, 'sending'), eq(D.nextAttemptAt, d.nextAttemptAt!));
    tally(await withOrg(db, orgId, (tx) => finalizeTx(tx, d, outcome, clockAfter(now), mine)));
  }
  return summary;
}

async function viewsTx(tx: Tx, rows: DeliveryRow[]): Promise<DeliveryView[]> {
  if (rows.length === 0) return [];
  const channelIds = [...new Set(rows.map((r) => r.channelId))];
  const chans = await tx.select().from(notificationChannels).where(inArray(notificationChannels.id, channelIds));
  const ruleIds = [...new Set(rows.map((r) => r.ruleId).filter((x): x is string => !!x))];
  const rules = ruleIds.length ? await tx.select({ id: notificationRules.id, name: notificationRules.name }).from(notificationRules).where(inArray(notificationRules.id, ruleIds)) : [];
  const scheduleIds = [...new Set(rows.map((r) => r.scheduleId).filter((x): x is string => !!x))];
  const schedules = scheduleIds.length
    ? await tx
        .select({ id: notificationSchedules.id, name: notificationSchedules.name, alertState: notificationSchedules.alertState })
        .from(notificationSchedules)
        .where(inArray(notificationSchedules.id, scheduleIds))
    : [];
  return rows.map((r) => {
    const ch = chans.find((c) => c.id === r.channelId)!;
    const schedule = schedules.find((s) => s.id === r.scheduleId);
    const legacy = r.payload?.type === 'legacy';
    return {
      id: r.id,
      kind: r.kind,
      source: {
        type: r.kind,
        id: r.ruleId ?? r.scheduleId,
        name: r.kind === 'rule' ? (rules.find((x) => x.id === r.ruleId)?.name ?? null) : r.kind === 'schedule' ? (schedule?.name ?? null) : null,
        alert: schedule?.alertState === 'alert',
      },
      channel: { id: ch.id, name: ch.name, kind: ch.kind },
      eventId: r.eventId,
      status: r.status,
      attempts: r.attempts,
      nextAttemptAt: r.nextAttemptAt,
      response: r.response,
      sentAt: r.sentAt,
      createdAt: r.createdAt,
      preview: payloadPreview(r.payload),
      legacy,
      canResend: !legacy && (r.status === 'sent' || r.status === 'dead') && ch.enabled,
    };
  });
}

async function viewOf(db: Db, orgId: string, id: string): Promise<DeliveryView> {
  return withOrg(db, orgId, async (tx) => {
    const [row] = await tx.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, id));
    if (!row) throw new AppError('not_found', NOT_FOUND);
    return (await viewsTx(tx, [row]))[0]!;
  });
}

/** 发一条固定内容的测试消息：只对启用的通道；在请求内同步发送一次，失败不重试。 */
export async function sendTestMessage(db: Db, actor: Actor, channelId: string, deps: NotifyDeps): Promise<DeliveryView> {
  requireOrgAdmin(actor);
  const now = new Date();
  const id = await withOrg(db, actor.orgId, async (tx) => {
    const [ch] = await tx.select().from(notificationChannels).where(eq(notificationChannels.id, channelId));
    if (!ch) throw new AppError('not_found', '通道不存在');
    if (!ch.enabled) throw new AppError('invalid', '通道已停用，启用后才能发送测试消息');
    const ctx = await orgContextTx(tx, actor.orgId, deps.publicUrl);
    const [payload] = toChannelPayloads(ch.kind, { format: 'text', text: `Flower 测试消息：通道「${ch.name}」可以正常接收推送。\n发送时间：${formatMinute(now, ctx.timeZone)}` });
    const [row] = await tx
      .insert(notificationDeliveries)
      .values({ orgId: actor.orgId, kind: 'test', channelId, payload: payload!, status: 'pending', nextAttemptAt: now })
      .returning({ id: notificationDeliveries.id });
    await recordEvent(tx, { orgId: actor.orgId, type: 'notification_channel.tested', subjectType: 'notification_channel', subjectId: channelId, actor, payload: { deliveryId: row!.id } });
    return row!.id;
  });
  await processDueDeliveries(db, actor.orgId, deps, now, { onlyIds: [id] });
  return viewOf(db, actor.orgId, id);
}

/** 重发：复制为新的待发记录（不带 run_id，不影响定时推送的告警计数）。 */
export async function resendDelivery(db: Db, actor: Actor, id: string): Promise<DeliveryView> {
  requireOrgAdmin(actor);
  const newId = await withOrg(db, actor.orgId, async (tx) => {
    const [cur] = await tx.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, id));
    if (!cur) throw new AppError('not_found', NOT_FOUND);
    if (cur.payload?.type === 'legacy') throw new AppError('invalid', '迁移来的历史记录不能重发');
    if (cur.status !== 'sent' && cur.status !== 'dead') throw new AppError('invalid', '只能重发已发送或已放弃的记录');
    const [ch] = await tx.select({ enabled: notificationChannels.enabled }).from(notificationChannels).where(eq(notificationChannels.id, cur.channelId));
    if (!ch?.enabled) throw new AppError('invalid', '通道已停用，启用后才能重发');
    const [row] = await tx
      .insert(notificationDeliveries)
      .values({
        orgId: actor.orgId,
        kind: cur.kind,
        ruleId: cur.ruleId,
        scheduleId: cur.scheduleId,
        channelId: cur.channelId,
        eventId: cur.eventId,
        payload: cur.payload,
        status: 'pending',
        nextAttemptAt: new Date(),
      })
      .returning({ id: notificationDeliveries.id });
    await recordEvent(tx, { orgId: actor.orgId, type: 'notification_delivery.resent', subjectType: 'notification_delivery', subjectId: row!.id, actor, payload: { from: id } });
    return row!.id;
  });
  return viewOf(db, actor.orgId, newId);
}

const CURSOR_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/**
 * 发送记录：按 (created_at, id) 倒序。游标为上一页最后一条的 `{created_at 微秒精度 UTC}|{id}`：
 * 同一事务写入的记录 created_at 相同，且 JS Date 只有毫秒精度，所以时间取数据库里的文本，按行值比较。
 */
export async function listDeliveries(db: Db, actor: Actor, q: DeliveryQuery): Promise<{ deliveries: DeliveryView[]; nextCursor: string | null }> {
  requireOrgAdmin(actor);
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 100);
  let cursor: { at: string; id: string } | null = null;
  if (q.before) {
    const m = CURSOR_RE.exec(q.before);
    if (!m) throw new AppError('invalid', '分页参数无效');
    cursor = { at: m[1]!, id: m[2]! };
  }
  return withOrg(db, actor.orgId, async (tx) => {
    const D = notificationDeliveries;
    const rows = await tx
      .select({ row: D, cursorAt: sql<string>`to_char(${D.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` })
      .from(D)
      .where(
        and(
          q.channelId ? eq(D.channelId, q.channelId) : undefined,
          q.kind ? eq(D.kind, q.kind) : undefined,
          q.status ? eq(D.status, q.status) : undefined,
          q.from ? gte(D.createdAt, q.from) : undefined,
          q.to ? lt(D.createdAt, q.to) : undefined,
          cursor ? sql`(${D.createdAt}, ${D.id}) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)` : undefined,
        ),
      )
      .orderBy(desc(D.createdAt), desc(D.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return { deliveries: await viewsTx(tx, page.map((r) => r.row)), nextCursor: rows.length > limit && last ? `${last.cursorAt}|${last.row.id}` : null };
  });
}
