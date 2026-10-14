import { asc, and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { domainEvents, memberNotifications, members, notificationCursors, organizations } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import { causeMessage } from '../notifications/worker';
import { type EventRow, pickRecipients, planEventTx } from './content';
import { dispatchPersonalTx, type OutboundItem } from './dispatch';
import { prefsForTx } from './prefs';
import { eligibleMembersTx } from './recipients';
import { autoSubscribeTx } from './subscriptions';

export type GenerateSummary = { events: number; notifications: number; skipped: number };
/** 每轮每个组织最多处理的事件数。 */
export const EVENT_BATCH = 500;
/** 同一条事件连续失败这么多次后跳过。 */
export const MAX_EVENT_FAILURES = 3;
/** 开启超过这么久的事务不再挡住通知生成（泄漏的 idle in transaction 连接或长时间维护事务），只记警告。 */
export const STALE_TRANSACTION_MS = 10 * 60 * 1000;

const E = domainEvents;
const C = notificationCursors;
const N = memberNotifications;

type StaleTransaction = { pid: number; ageSeconds: number };

/**
 * 本批事件的时间上限：本库其他会话里最早的事务开始时间（不晚于本事务的 now()）。领域事件的 occurred_at 是写入事务的开始时间，
 * 未提交事务里的事件提交前看不到，若不加这个上限，游标会越过它。开启超过 staleMs 的事务不计入，另行返回以便告警。
 * 上限以文本返回，再以 timestamptz 参数传给事件查询，保留微秒精度。
 * pg_stat_activity 在事务内首次访问时拍快照，之后不变，所以先 pg_stat_clear_snapshot() 再读，每批只读一次。
 */
async function eventBoundTx(tx: Tx, staleMs: number): Promise<{ bound: string; stale: StaleTransaction[] }> {
  await tx.execute(sql`select pg_stat_clear_snapshot()`);
  const limit = sql`now() - ${staleMs} * interval '1 millisecond'`;
  const [row] = (await tx.execute(sql`
    with a as (
      select pid, xact_start from pg_stat_activity
      where datname = current_database() and pid <> pg_backend_pid() and xact_start is not null
    )
    select
      (select least(now(), coalesce(min(xact_start), now())) from a where xact_start > ${limit})::text as bound,
      coalesce((select json_agg(json_build_object('pid', pid, 'ageSeconds', floor(extract(epoch from now() - xact_start))::int)) from a where xact_start <= ${limit}), '[]'::json) as stale
  `)) as unknown as [{ bound: string; stale: StaleTransaction[] }];
  return row;
}

/** 游标之后、且早于上限的事件。比较全部在 SQL 里做（occurred_at 为微秒精度）。 */
const pendingEvents = (orgId: string, bound: string) =>
  and(
    eq(E.orgId, orgId),
    sql`not exists (select 1 from ${C} c where c.org_id = ${E.orgId} and c.last_event_id is not null and (${E.occurredAt}, ${E.id}) <= (c.last_occurred_at, c.last_event_id))`,
    sql`${E.occurredAt} < ${bound}::timestamptz`,
  );

/**
 * 处理一条事件：算收件人、按偏好写站内通知（同一人同一事件同一类只一条）、补自动关注；
 * 偏好开了企业微信或邮件的，收集成个人提醒，由调用方在本轮结束时合并分发。
 */
async function processEventTx(tx: Tx, ev: EventRow, slug: string): Promise<{ created: number; outbound: OutboundItem[] }> {
  const plan = await planEventTx(tx, ev, slug);
  if (!plan) return { created: 0, outbound: [] };
  const chosen = pickRecipients(plan.candidates, ev.actorMemberId);
  // 不关联产品的工作项：任何非访客成员都能看到，访客看不到
  const excludeGuests = plan.subject.type === 'work_item' && plan.subject.productId === null;
  const eligible = await eligibleMembersTx(tx, plan.subject.productId, [...chosen.keys(), ...plan.autoSubscribe], { excludeGuests });
  const recipients = [...chosen.values()].filter((c) => eligible.has(c.memberId));
  const prefs = await prefsForTx(tx, recipients.map((c) => c.memberId));
  const [actor] = ev.actorMemberId ? await tx.select({ name: members.displayName }).from(members).where(eq(members.id, ev.actorMemberId)) : [];
  let created = 0;
  const outbound: OutboundItem[] = [];
  for (const c of recipients) {
    const pref = prefs.get(c.memberId)![c.kind];
    if (pref.inApp) {
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
    if (pref.wecom || pref.email) {
      const m = eligible.get(c.memberId)!;
      outbound.push({
        productId: plan.subject.productId,
        memberId: m.id,
        email: m.email,
        wecomUserid: m.wecomUserid,
        viaWecom: pref.wecom,
        viaEmail: pref.email,
        actorName: actor?.name ?? null,
        body: c.body,
        title: plan.subject.title,
        url: plan.subject.url,
      });
    }
  }
  const type = plan.subject.type;
  if (type === 'requirement' || type === 'document' || type === 'work_item') {
    await autoSubscribeTx(tx, ev.orgId, { type, id: plan.subject.id }, plan.autoSubscribe.filter((id) => eligible.has(id)));
  }
  return { created, outbound };
}

/**
 * 处理一个组织游标之后的新事件（最多 EVENT_BATCH 条）。先建游标行再 SKIP LOCKED 锁住：拿不到说明另一个实例在处理，本轮跳过。
 * 每条事件在 savepoint 里处理，成功后前移游标；失败时记下事件与次数并结束本轮，同一条连续失败 MAX_EVENT_FAILURES 次后跳过。
 * legacy.* 事件不处理，只前移游标。本轮的企业微信与邮件提醒在最后合并写入发送队列。后台写入，不记领域事件。
 */
export async function generateMemberNotifications(
  db: Db,
  orgId: string,
  deps: { publicUrl: string; staleTransactionMs?: number },
  now: Date,
): Promise<GenerateSummary> {
  return withOrg(db, orgId, async (tx) => {
    const summary: GenerateSummary = { events: 0, notifications: 0, skipped: 0 };
    await tx.insert(C).values({ orgId }).onConflictDoNothing();
    const [cursor] = await tx.select().from(C).where(eq(C.orgId, orgId)).for('update', { skipLocked: true });
    if (!cursor) return summary;
    const [org] = await tx.select({ slug: organizations.slug }).from(organizations).where(eq(organizations.id, orgId));
    // 上限必须在事件查询之前单独取：事件查询的快照要晚于读上限的时刻。若放在同一条语句里，
    // 某个事务恰好在语句快照之后、读 pg_stat_activity 之前提交，它的事件不在快照里，它也不再计入上限，游标会越过它。
    const { bound, stale } = await eventBoundTx(tx, deps.staleTransactionMs ?? STALE_TRANSACTION_MS);
    for (const s of stale) console.warn(`[notify] 有事务已开启 ${s.ageSeconds} 秒，站内通知生成不再等待它：pid=${s.pid}`);
    const events = await tx.select().from(E).where(pendingEvents(orgId, bound)).orderBy(asc(E.occurredAt), asc(E.id)).limit(EVENT_BATCH);
    const outbound: OutboundItem[] = [];
    let last: string | null = null;
    let failing: { eventId: string; failures: number } | null = null;
    for (const ev of events) {
      if (!ev.type.startsWith('legacy.')) {
        try {
          const r = await tx.transaction((sp) => processEventTx(sp, ev, org!.slug));
          summary.notifications += r.created;
          outbound.push(...r.outbound);
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
    if (outbound.length > 0) {
      try {
        await tx.transaction((sp) => dispatchPersonalTx(sp, orgId, outbound, deps.publicUrl, now));
      } catch (e) {
        console.warn(`[notify] 个人提醒写入发送队列失败，本轮的企业微信与邮件提醒未发送：org=${orgId}：${causeMessage(e)}`);
      }
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
