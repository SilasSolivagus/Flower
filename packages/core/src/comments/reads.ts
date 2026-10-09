import { and, eq, notInArray } from 'drizzle-orm';
import { commentReads, comments } from '../db/schema';
import type { Tx } from '../db/tx';
import type { Actor } from '../domain-types';

/**
 * 把一个需求或 PRD 上的全部评论对 actor 标为已读，返回新标记的条数。
 * 调用方负责加载目标并检查权限。标记已读不记领域事件（与 P1 需求评论已读一致）。
 */
export async function markCommentsRead(tx: Tx, actor: Actor, target: { type: 'requirement' | 'document'; id: string }): Promise<number> {
  const already = tx.select({ id: commentReads.commentId }).from(commentReads).where(eq(commentReads.memberId, actor.memberId));
  const unread = await tx
    .select({ id: comments.id })
    .from(comments)
    .where(and(eq(comments.targetType, target.type), eq(comments.targetId, target.id), notInArray(comments.id, already)));
  if (unread.length === 0) return 0;
  await tx
    .insert(commentReads)
    .values(unread.map((c) => ({ orgId: actor.orgId, commentId: c.id, memberId: actor.memberId })))
    .onConflictDoNothing();
  return unread.length;
}
