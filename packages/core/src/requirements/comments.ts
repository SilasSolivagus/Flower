import { and, asc, eq, notInArray } from 'drizzle-orm';
import { requireProductRole } from '../access/permissions';
import type { Db } from '../db/client';
import { commentReads, comments } from '../db/schema';
import { withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import { type LinkCard, linkCardsFor, sourceKey } from '../links/cards';
import { syncSourceLinks } from '../links/links';
import { loadRequirement, memberNames } from './context';
import { type MemberRef, productKeyOf } from './requirements';

export type CommentView = {
  id: string;
  parentId: string | null;
  author: MemberRef | null;
  body: string;
  kind: 'comment' | 'update';
  createdAt: Date;
  read: boolean;
  links: LinkCard[];
};

const onRequirement = (requirementId: string) => and(eq(comments.targetType, 'requirement'), eq(comments.targetId, requirementId));

export async function listRequirementComments(db: Db, actor: Actor, requirementId: string): Promise<CommentView[]> {
  return withOrg(db, actor.orgId, async (tx) => {
    const req = await loadRequirement(tx, requirementId);
    await requireProductRole(tx, actor, req.productId, 'viewer');
    const rows = await tx.select().from(comments).where(onRequirement(requirementId)).orderBy(asc(comments.createdAt), asc(comments.id));
    const reads = await tx
      .select({ commentId: commentReads.commentId })
      .from(commentReads)
      .innerJoin(comments, eq(comments.id, commentReads.commentId))
      .where(and(onRequirement(requirementId), eq(commentReads.memberId, actor.memberId)));
    const readSet = new Set(reads.map((r) => r.commentId));
    const names = await memberNames(tx, rows.map((r) => r.authorMemberId));
    const cards = await linkCardsFor(tx, actor, rows.map((c) => ({ type: 'comment' as const, id: c.id })));
    return rows.map((c) => ({
      id: c.id,
      parentId: c.parentId,
      author: c.authorMemberId ? { id: c.authorMemberId, displayName: names.get(c.authorMemberId) ?? '已删除的成员' } : null,
      body: c.body,
      kind: c.kind,
      createdAt: c.createdAt,
      read: readSet.has(c.id),
      links: cards.get(sourceKey('comment', c.id))!,
    }));
  });
}

export async function addRequirementComment(
  db: Db,
  actor: Actor,
  requirementId: string,
  input: { body: string; kind?: 'comment' | 'update'; parentId?: string | null },
): Promise<CommentView> {
  if (actor.tokenScope?.access === 'read') throw new AppError('forbidden', '只读 Token 不能评论');
  const body = input.body.trim();
  if (!body || body.length > 10_000) throw new AppError('invalid', '评论不能为空，且不超过 10000 个字符');
  return withOrg(db, actor.orgId, async (tx) => {
    const req = await loadRequirement(tx, requirementId);
    await requireProductRole(tx, actor, req.productId, 'viewer');
    if (input.parentId) {
      const [parent] = await tx.select().from(comments).where(and(eq(comments.id, input.parentId), onRequirement(requirementId)));
      if (!parent) throw new AppError('invalid', '回复的评论不存在');
    }
    const [row] = await tx
      .insert(comments)
      .values({ orgId: actor.orgId, targetType: 'requirement', targetId: requirementId, parentId: input.parentId ?? null, authorMemberId: actor.memberId, body, kind: input.kind ?? 'comment' })
      .returning();
    await tx.insert(commentReads).values({ orgId: actor.orgId, commentId: row!.id, memberId: actor.memberId });
    await syncSourceLinks(tx, actor.orgId, { type: 'comment', id: row!.id, productKey: await productKeyOf(tx, req.productId) }, body);
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: req.productId,
      type: 'comment.created',
      subjectType: 'requirement',
      subjectId: requirementId,
      actor,
      payload: { commentId: row!.id, kind: row!.kind },
    });
    const names = await memberNames(tx, [actor.memberId]);
    const cards = await linkCardsFor(tx, actor, [{ type: 'comment', id: row!.id }]);
    return {
      id: row!.id,
      parentId: row!.parentId,
      author: { id: actor.memberId, displayName: names.get(actor.memberId) ?? '' },
      body: row!.body,
      kind: row!.kind,
      createdAt: row!.createdAt,
      read: true,
      links: cards.get(sourceKey('comment', row!.id))!,
    };
  });
}

export async function markRequirementCommentsRead(db: Db, actor: Actor, requirementId: string): Promise<number> {
  if (actor.tokenScope?.access === 'read') throw new AppError('forbidden', '只读 Token 不能标记已读');
  return withOrg(db, actor.orgId, async (tx) => {
    const req = await loadRequirement(tx, requirementId);
    await requireProductRole(tx, actor, req.productId, 'viewer');
    const already = tx.select({ id: commentReads.commentId }).from(commentReads).where(eq(commentReads.memberId, actor.memberId));
    const unread = await tx
      .select({ id: comments.id })
      .from(comments)
      .where(and(onRequirement(requirementId), notInArray(comments.id, already)));
    if (unread.length === 0) return 0;
    await tx
      .insert(commentReads)
      .values(unread.map((c) => ({ orgId: actor.orgId, commentId: c.id, memberId: actor.memberId })))
      .onConflictDoNothing();
    return unread.length;
  });
}
