import { and, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import type { Db } from '../db/client';
import { notificationDeliveries, notificationSchedules } from '../db/schema';
import { withOrg, withSystem } from '../db/tx';
import { nextRunAt } from './cron';
import { type ProcessSummary, processDueDeliveries } from './deliveries';
import { generateScheduleRunTx, tryScheduleLockTx } from './run';
import type { NotifyDeps } from './sender';

export type TickSummary = ProcessSummary & { orgs: number; schedulesRun: number };
export type NotificationWorker = { start(): void; stop(): Promise<void> };

const S = notificationSchedules;
const D = notificationDeliveries;
const dueSchedule = (now: Date) => and(eq(S.enabled, true), or(isNull(S.nextRunAt), lte(S.nextRunAt, now)));

/** 后台循环唯一的跨组织查询：有到期（或租约到期）的发送记录、或有需要排期或到点的定时推送的组织。 */
async function dueOrgIds(db: Db, now: Date): Promise<string[]> {
  return withSystem(db, async (tx) => {
    const a = await tx.selectDistinct({ orgId: D.orgId }).from(D).where(and(inArray(D.status, ['pending', 'failed', 'sending']), lte(D.nextAttemptAt, now)));
    const b = await tx.selectDistinct({ orgId: S.orgId }).from(S).where(dueSchedule(now));
    return [...new Set([...a, ...b].map((r) => r.orgId))];
  });
}

async function recordGenerationFailure(db: Db, orgId: string, id: string, error: unknown, now: Date): Promise<void> {
  await withOrg(db, orgId, async (tx) => {
    const [s] = await tx.select().from(S).where(eq(S.id, id)).for('update');
    if (!s) return;
    const failures = s.consecutiveFailures + 1;
    await tx
      .update(S)
      .set({
        lastRunAt: now,
        lastError: `生成内容失败：${error instanceof Error ? error.message : String(error)}`.slice(0, 500),
        consecutiveFailures: failures,
        alertState: failures >= s.failThreshold ? 'alert' : s.alertState,
        nextRunAt: nextRunAt(s.cron, s.timezone, now),
        updatedAt: now,
      })
      .where(eq(S.id, id));
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
      await recordGenerationFailure(db, orgId, id, e, now);
    }
  }
  return ran;
}

/** 一轮：逐个组织执行到点的定时推送，再发送到期的记录。测试与端到端用它手动驱动。 */
export async function runNotificationTick(db: Db, deps: NotifyDeps, now: Date = new Date()): Promise<TickSummary> {
  const summary: TickSummary = { orgs: 0, schedulesRun: 0, sent: 0, failed: 0, dead: 0, rateLimited: 0 };
  for (const orgId of await dueOrgIds(db, now)) {
    summary.orgs++;
    summary.schedulesRun += await runDueSchedules(db, orgId, deps, now);
    const r = await processDueDeliveries(db, orgId, deps, now);
    summary.sent += r.sent;
    summary.failed += r.failed;
    summary.dead += r.dead;
    summary.rateLimited += r.rateLimited;
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
