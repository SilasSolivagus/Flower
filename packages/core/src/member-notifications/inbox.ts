import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { memberNotifications, members } from '../db/schema';
import { withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError } from '../errors';
import { type MemberNotificationKind, NOTIFICATION_RETENTION_DAYS, type NotificationSubjectType } from '../notifications/constants';

export type MemberNotificationView = {
  id: string;
  kind: MemberNotificationKind;
  subjectType: NotificationSubjectType;
  subjectId: string;
  title: string;
  body: string;
  url: string;
  actor: { id: string; displayName: string } | null;
  createdAt: Date;
  readAt: Date | null;
};
export type NotificationFilter = 'all' | 'unread' | 'mentioned';
export type NotificationListQuery = { filter?: NotificationFilter; kind?: MemberNotificationKind; before?: string; limit?: number };

const N = memberNotifications;
const CURSOR_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

function assertCanMark(actor: Actor): void {
  if (actor.tokenScope?.access === 'read') throw new AppError('forbidden', '只读 Token 不能标记已读');
}

/** 已读通知的保留期限：早于这个时间读过的通知会被删除。 */
export const retentionCutoff = (now: Date): Date => new Date(now.getTime() - NOTIFICATION_RETENTION_DAYS * 86_400_000);

/**
 * 本人的通知：按 (created_at, id) 倒序。游标为上一页最后一条的 `{created_at 微秒精度 UTC}|{id}`
 * （与发送记录相同：同一事务写入的通知 created_at 相同，JS Date 只有毫秒精度）。操作人显示当前姓名。
 */
export async function listMyNotifications(db: Db, actor: Actor, q: NotificationListQuery = {}): Promise<{ notifications: MemberNotificationView[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(q.limit ?? 20, 1), 100);
  let cursor: { at: string; id: string } | null = null;
  if (q.before) {
    const m = CURSOR_RE.exec(q.before);
    if (!m) throw new AppError('invalid', '分页参数无效');
    cursor = { at: m[1]!, id: m[2]! };
  }
  return withOrg(db, actor.orgId, async (tx) => {
    const rows = await tx
      .select({ n: N, actorName: members.displayName, cursorAt: sql<string>`to_char(${N.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` })
      .from(N)
      .leftJoin(members, eq(members.id, N.actorMemberId))
      .where(
        and(
          eq(N.memberId, actor.memberId),
          q.filter === 'unread' ? isNull(N.readAt) : undefined,
          q.filter === 'mentioned' ? eq(N.kind, 'mentioned') : undefined,
          q.kind ? eq(N.kind, q.kind) : undefined,
          cursor ? sql`(${N.createdAt}, ${N.id}) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)` : undefined,
        ),
      )
      .orderBy(desc(N.createdAt), desc(N.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      notifications: page.map(({ n, actorName }) => ({
        id: n.id,
        kind: n.kind,
        subjectType: n.subjectType,
        subjectId: n.subjectId,
        title: n.title,
        body: n.body,
        url: n.url,
        actor: n.actorMemberId ? { id: n.actorMemberId, displayName: actorName ?? '已删除的成员' } : null,
        createdAt: n.createdAt,
        readAt: n.readAt,
      })),
      nextCursor: rows.length > limit && last ? `${last.cursorAt}|${last.n.id}` : null,
    };
  });
}

export async function countMyUnread(db: Db, actor: Actor): Promise<number> {
  return withOrg(db, actor.orgId, async (tx) => {
    const [r] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(N)
      .where(and(eq(N.memberId, actor.memberId), isNull(N.readAt)));
    return r!.n;
  });
}

/** 标一条已读：只能标本人的通知（别人的报不存在）。标记已读不记领域事件（与评论已读一致）。 */
export async function markNotificationRead(db: Db, actor: Actor, id: string): Promise<void> {
  assertCanMark(actor);
  await withOrg(db, actor.orgId, async (tx) => {
    const [row] = await tx
      .select({ readAt: N.readAt })
      .from(N)
      .where(and(eq(N.id, id), eq(N.memberId, actor.memberId)));
    if (!row) throw new AppError('not_found', '通知不存在');
    if (!row.readAt) await tx.update(N).set({ readAt: new Date() }).where(eq(N.id, id));
  });
}

export async function markAllNotificationsRead(db: Db, actor: Actor): Promise<number> {
  assertCanMark(actor);
  return withOrg(db, actor.orgId, async (tx) => {
    const rows = await tx
      .update(N)
      .set({ readAt: new Date() })
      .where(and(eq(N.memberId, actor.memberId), isNull(N.readAt)))
      .returning({ id: N.id });
    return rows.length;
  });
}

/** 打开需求、PRD 或任务详情时，把本人与它相关的未读通知标为已读。 */
export async function markSubjectNotificationsRead(db: Db, actor: Actor, subject: { type: NotificationSubjectType; id: string }): Promise<number> {
  assertCanMark(actor);
  return withOrg(db, actor.orgId, async (tx) => {
    const rows = await tx
      .update(N)
      .set({ readAt: new Date() })
      .where(and(eq(N.memberId, actor.memberId), eq(N.subjectType, subject.type), eq(N.subjectId, subject.id), isNull(N.readAt)))
      .returning({ id: N.id });
    return rows.length;
  });
}

/** 后台循环：删除已读超过保留期的通知（不记事件）。 */
export async function deleteExpiredNotifications(db: Db, orgId: string, now: Date): Promise<number> {
  return withOrg(db, orgId, async (tx) => (await tx.delete(N).where(lt(N.readAt, retentionCutoff(now))).returning({ id: N.id })).length);
}
