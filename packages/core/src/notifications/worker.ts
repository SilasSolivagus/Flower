import { and, eq, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { domainEvents, memberNotifications, notificationCursors, notificationDeliveries, notificationSchedules, organizations, wecomBindStates } from '../db/schema';
import { withOrg, withSystem } from '../db/tx';
import { notifyScheduleAlertTx } from '../member-notifications/alerts';
import { generateMemberNotifications } from '../member-notifications/generate';
import { deleteExpiredNotifications, retentionCutoff } from '../member-notifications/inbox';
import { nextRunAt } from './cron';
import { type ProcessSummary, processDueDeliveries } from './deliveries';
import { generateScheduleRunTx, tryScheduleLockTx } from './run';
import type { NotifyDeps } from './sender';

export type TickSummary = ProcessSummary & { orgs: number; schedulesRun: number; events: number; notified: number };
export type NotificationWorker = { start(): void; stop(): Promise<void> };

const S = notificationSchedules;
const D = notificationDeliveries;
const bindStateCutoff = (now: Date): Date => new Date(now.getTime() - 86_400_000);
const dueSchedule = (now: Date) => and(eq(S.enabled, true), or(isNull(S.nextRunAt), lte(S.nextRunAt, now)));

/**
 * 后台循环唯一的跨组织查询：有到期（或租约到期）的发送记录、有需要排期或到点的定时推送、
 * 游标之后有新事件（没有游标行的组织从头处理）、或有过期数据待清理的组织。
 */
async function dueOrgIds(db: Db, now: Date): Promise<string[]> {
  return withSystem(db, async (tx) => {
    const a = await tx.selectDistinct({ orgId: D.orgId }).from(D).where(and(inArray(D.status, ['pending', 'failed', 'sending']), lte(D.nextAttemptAt, now)));
    const b = await tx.selectDistinct({ orgId: S.orgId }).from(S).where(dueSchedule(now));
    const c = await tx
      .select({ orgId: organizations.id })
      .from(organizations)
      .where(
        and(
          isNull(organizations.deletedAt),
          sql`exists (select 1 from ${domainEvents} e left join ${notificationCursors} c on c.org_id = e.org_id
                      where e.org_id = ${organizations.id} and (c.last_event_id is null or (e.occurred_at, e.id) > (c.last_occurred_at, c.last_event_id)))`,
        ),
      );
    // 有已读超过保留期的通知、或过期超过一天的扫码绑定 state 的组织
    const d = await tx.selectDistinct({ orgId: memberNotifications.orgId }).from(memberNotifications).where(lt(memberNotifications.readAt, retentionCutoff(now)));
    const e = await tx.selectDistinct({ orgId: wecomBindStates.orgId }).from(wecomBindStates).where(lt(wecomBindStates.expiresAt, bindStateCutoff(now)));
    return [...new Set([...a, ...b, ...c, ...d, ...e].map((r) => r.orgId))];
  });
}

/** 只取底层原因（drizzle 的查询错误把 SQL 与参数放在外层 message 里，原因在 cause 中）。 */
function causeMessage(e: unknown): string {
  const cause = e instanceof Error && e.cause instanceof Error ? e.cause : e;
  return cause instanceof Error ? cause.message : String(cause);
}

async function recordGenerationFailure(db: Db, orgId: string, id: string, error: unknown, now: Date, publicUrl: string): Promise<void> {
  await withOrg(db, orgId, async (tx) => {
    const [s] = await tx.select().from(S).where(eq(S.id, id)).for('update');
    if (!s) return;
    const failures = s.consecutiveFailures + 1;
    let next: Date;
    try {
      next = nextRunAt(s.cron, s.timezone, now);
    } catch (e) {
      // 存储的 cron 或时区无效，不会自行恢复：停用并告警，避免每轮重复出错
      const reason = causeMessage(e);
      await tx
        .update(S)
        .set({
          enabled: false,
          nextRunAt: null,
          lastRunAt: now,
          lastError: `定时规则或时区无效，已停用：${reason}`.slice(0, 500),
          consecutiveFailures: failures,
          alertState: 'alert',
          updatedAt: now,
        })
        .where(eq(S.id, id));
      if (s.alertState !== 'alert') await notifyScheduleAlertTx(tx, s, '定时规则或时区无效，已停用并进入告警', publicUrl, now);
      console.warn(`[notify] 定时推送的定时规则或时区无效，已停用：org=${orgId} schedule=${id}：${reason}`);
      return;
    }
    const alert = failures >= s.failThreshold;
    await tx
      .update(S)
      .set({
        lastRunAt: now,
        lastError: `生成内容失败：${causeMessage(error)}`.slice(0, 500),
        consecutiveFailures: failures,
        alertState: alert ? 'alert' : s.alertState,
        nextRunAt: next,
        updatedAt: now,
      })
      .where(eq(S.id, id));
    if (alert && s.alertState !== 'alert') await notifyScheduleAlertTx(tx, s, `连续失败 ${failures} 次，已进入告警`, publicUrl, now);
  });
}

async function runDueSchedules(db: Db, orgId: string, deps: NotifyDeps, now: Date): Promise<number> {
  const due = await withOrg(db, orgId, (tx) => tx.select({ id: S.id }).from(S).where(dueSchedule(now)));
  let ran = 0;
  for (const { id } of due) {
    try {
      const did = await withOrg(db, orgId, async (tx) => {
        if (!(await tryScheduleLockTx(tx, id))) return false;
        // 拿到锁后重新读取：另一个实例可能刚执行完并推进了 next_run_at
        const [s] = await tx.select().from(S).where(eq(S.id, id));
        if (!s || !s.enabled) return false;
        const next = nextRunAt(s.cron, s.timezone, now);
        if (s.nextRunAt === null) {
          // 没有排期（迁移导入的定时推送）：只排期，不补跑
          await tx.update(S).set({ nextRunAt: next }).where(eq(S.id, id));
          return false;
        }
        if (s.nextRunAt.getTime() > now.getTime()) return false;
        await generateScheduleRunTx(tx, s, deps, now);
        await tx.update(S).set({ nextRunAt: next }).where(eq(S.id, id));
        return true;
      });
      if (did) ran++;
    } catch (e) {
      await recordGenerationFailure(db, orgId, id, e, now, deps.publicUrl);
    }
  }
  return ran;
}

/**
 * 一轮：逐个组织先生成站内通知，再执行到点的定时推送，最后发送到期的记录。测试与端到端传入 now 手动驱动；
 * 不传时每个组织开始处理时取当前时间（前面的组织可能处理了几分钟，不能沿用本轮开始的时间）。
 */
export async function runNotificationTick(db: Db, deps: NotifyDeps, now?: Date): Promise<TickSummary> {
  const summary: TickSummary = { orgs: 0, schedulesRun: 0, events: 0, notified: 0, sent: 0, failed: 0, dead: 0, rateLimited: 0 };
  for (const orgId of await dueOrgIds(db, now ?? new Date())) {
    summary.orgs++;
    const orgNow = now ?? new Date();
    // 每个组织单独兜底：一个组织出错只跳过它本轮剩下的处理，不影响其他组织
    try {
      const g = await generateMemberNotifications(db, orgId, deps, orgNow);
      summary.events += g.events;
      summary.notified += g.notifications;
      summary.schedulesRun += await runDueSchedules(db, orgId, deps, orgNow);
      await deleteExpiredNotifications(db, orgId, orgNow);
      await withOrg(db, orgId, (tx) => tx.delete(wecomBindStates).where(lt(wecomBindStates.expiresAt, bindStateCutoff(orgNow))));
      const r = await processDueDeliveries(db, orgId, deps, orgNow);
      summary.sent += r.sent;
      summary.failed += r.failed;
      summary.dead += r.dead;
      summary.rateLimited += r.rateLimited;
    } catch (e) {
      console.warn(`[notify] 组织本轮处理出错，已跳过：org=${orgId}：${causeMessage(e)}`);
    }
  }
  return summary;
}

/** 后台循环：每轮结束后等 intervalMs 再开始下一轮（不重叠）；stop() 停止取新任务并等当前一轮结束。 */
export function createNotificationWorker(db: Db, deps: NotifyDeps, opts: { intervalMs?: number; onError?: (e: unknown) => void } = {}): NotificationWorker {
  const interval = opts.intervalMs ?? 5000;
  const onError = opts.onError ?? ((e: unknown) => console.error('[notify] 后台发送出错', e));
  let timer: ReturnType<typeof setTimeout> | null = null;
  let current: Promise<void> | null = null;
  let stopped = false;
  const schedule = () => {
    if (!stopped) timer = setTimeout(tick, interval);
  };
  const tick = () => {
    timer = null;
    current = runNotificationTick(db, deps)
      .then(() => undefined, onError)
      .finally(() => {
        current = null;
        schedule();
      });
  };
  return {
    start() {
      if (!stopped && !timer && !current) schedule();
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      await current;
    },
  };
}
