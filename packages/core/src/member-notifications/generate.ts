import { asc, and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { domainEvents, memberNotifications, notificationCursors, organizations } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import { type EventRow, pickRecipients, planEventTx } from './content';
import { prefsForTx } from './prefs';
import { eligibleMembersTx } from './recipients';
import { autoSubscribeTx } from './subscriptions';

export type GenerateSummary = { events: number; notifications: number; skipped: number };
/** 每轮每个组织最多处理的事件数。 */
export const EVENT_BATCH = 500;
/** 同一条事件连续失败这么多次后跳过。 */
export const MAX_EVENT_FAILURES = 3;

const E = domainEvents;
const C = notificationCursors;
const N = memberNotifications;

/** 只取底层原因（drizzle 的查询错误把 SQL 与参数放在外层 message 里）。 */
function causeMessage(e: unknown): string {
  const cause = e instanceof Error && e.cause instanceof Error ? e.cause : e;
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * 游标之后、且早于本库其他会话里最早的事务开始时间的事件。领域事件的 occurred_at 是写入事务的开始时间：
 * 未提交事务里的事件提交前看不到，若不加这个上限，游标会越过它。比较全部在 SQL 里做（occurred_at 为微秒精度）。
 */
const pendingEvents = (orgId: string) =>
  and(
    eq(E.orgId, orgId),
    sql`not exists (select 1 from ${C} c where c.org_id = ${E.orgId} and c.last_event_id is not null and (${E.occurredAt}, ${E.id}) <= (c.last_occurred_at, c.last_event_id))`,
    sql`${E.occurredAt} < (select least(now(), coalesce(min(a.xact_start), now())) from pg_stat_activity a where a.datname = current_database() and a.pid <> pg_backend_pid() and a.xact_start is not null)`,
  );

/** 处理一条事件：算收件人、按偏好写站内通知（同一人同一事件同一类只一条）、补自动关注。返回新写的通知数。 */
async function processEventTx(tx: Tx, ev: EventRow, slug: string): Promise<number> {
  const plan = await planEventTx(tx, ev, slug);
  if (!plan) return 0;
  const chosen = pickRecipients(plan.candidates, ev.actorMemberId);
  const eligible = await eligibleMembersTx(tx, plan.subject.productId, [...chosen.keys(), ...plan.autoSubscribe]);
  const recipients = [...chosen.values()].filter((c) => eligible.has(c.memberId));
  const prefs = await prefsForTx(tx, recipients.map((c) => c.memberId));
  let created = 0;
  for (const c of recipients) {
    if (!prefs.get(c.memberId)![c.kind].inApp) continue;
    const rows = await tx
      .insert(N)
      .values({
        orgId: ev.orgId,
        memberId: c.memberId,
        eventId: ev.id,
        kind: c.kind,
        subjectType: plan.subject.type,
        subjectId: plan.subject.id,
        title: plan.subject.title,
        body: c.body,
        url: plan.subject.url,
        actorMemberId: ev.actorMemberId,
      })
      .onConflictDoNothing()
      .returning({ id: N.id });
    created += rows.length;
  }
  const type = plan.subject.type;
  if (type === 'requirement' || type === 'document') {
    await autoSubscribeTx(tx, ev.orgId, { type, id: plan.subject.id }, plan.autoSubscribe.filter((id) => eligible.has(id)));
  }
  return created;
}

/**
 * 处理一个组织游标之后的新事件（最多 EVENT_BATCH 条）。先建游标行再 SKIP LOCKED 锁住：拿不到说明另一个实例在处理，本轮跳过。
 * 每条事件在 savepoint 里处理，成功后前移游标；失败时记下事件与次数并结束本轮，同一条连续失败 MAX_EVENT_FAILURES 次后跳过。
 * legacy.* 事件不处理，只前移游标。后台写入，不记领域事件。
 */
export async function generateMemberNotifications(db: Db, orgId: string, deps: { publicUrl: string }, now: Date): Promise<GenerateSummary> {
  return withOrg(db, orgId, async (tx) => {
    const summary: GenerateSummary = { events: 0, notifications: 0, skipped: 0 };
    await tx.insert(C).values({ orgId }).onConflictDoNothing();
    const [cursor] = await tx.select().from(C).where(eq(C.orgId, orgId)).for('update', { skipLocked: true });
    if (!cursor) return summary;
    const [org] = await tx.select({ slug: organizations.slug }).from(organizations).where(eq(organizations.id, orgId));
    const events = await tx.select().from(E).where(pendingEvents(orgId)).orderBy(asc(E.occurredAt), asc(E.id)).limit(EVENT_BATCH);
    let last: string | null = null;
    let failing: { eventId: string; failures: number } | null = null;
    for (const ev of events) {
      if (!ev.type.startsWith('legacy.')) {
        try {
          summary.notifications += await tx.transaction((sp) => processEventTx(sp, ev, org!.slug));
        } catch (e) {
          const failures = cursor.failingEventId === ev.id ? cursor.failures + 1 : 1;
          if (failures < MAX_EVENT_FAILURES) {
            console.warn(`[notify] 站内通知生成失败（第 ${failures} 次），下一轮重试：org=${orgId} event=${ev.id} type=${ev.type}：${causeMessage(e)}`);
            failing = { eventId: ev.id, failures };
            break;
          }
          console.warn(`[notify] 站内通知生成连续失败 ${MAX_EVENT_FAILURES} 次，跳过该事件：org=${orgId} event=${ev.id} type=${ev.type}：${causeMessage(e)}`);
          summary.skipped += 1;
        }
      }
      last = ev.id;
      summary.events += 1;
    }
    if (last || failing || cursor.failingEventId) {
      await tx
        .update(C)
        .set({
          ...(last ? { lastOccurredAt: sql`(select ${E.occurredAt} from ${E} where ${E.id} = ${last})`, lastEventId: last } : {}),
          failingEventId: failing?.eventId ?? null,
          failures: failing?.failures ?? 0,
          updatedAt: now,
        })
        .where(eq(C.orgId, orgId));
    }
    return summary;
  });
}
