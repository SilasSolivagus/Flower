import { and, eq, isNull, sql } from 'drizzle-orm';
import { requireProductRole } from '../access/permissions';
import type { Db } from '../db/client';
import { comments, documents, requirementAssignments, requirements, subscriptions } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import type { SubscriptionSource, SubscriptionSubjectType } from '../notifications/constants';

export type SubscriptionSubject = { type: SubscriptionSubjectType; id: string };
export type SubscriptionView = { following: boolean; source: SubscriptionSource | null; reason: string | null };

const S = subscriptions;

/** 关注对象的产品与负责人；不存在或已删除时报「不存在」。 */
async function loadSubjectTx(tx: Tx, s: SubscriptionSubject): Promise<{ productId: string; ownerMemberId: string | null }> {
  if (s.type === 'requirement') {
    const [r] = await tx
      .select({ productId: requirements.productId, ownerMemberId: requirements.ownerMemberId })
      .from(requirements)
      .where(and(eq(requirements.id, s.id), isNull(requirements.deletedAt)));
    if (!r) throw new AppError('not_found', '需求不存在');
    return r;
  }
  const [d] = await tx
    .select({ productId: documents.productId, ownerMemberId: documents.ownerMemberId })
    .from(documents)
    .where(and(eq(documents.id, s.id), isNull(documents.deletedAt)));
  if (!d) throw new AppError('not_found', 'PRD 不存在');
  return d;
}

/** 自动关注的原因按当前情况推断：负责人、被分配、评论过；都不是时为兜底说明。 */
async function reasonTx(tx: Tx, memberId: string, s: SubscriptionSubject, source: SubscriptionSource, ownerMemberId: string | null): Promise<string> {
  if (source === 'manual') return '你手动关注了';
  if (ownerMemberId === memberId) return '你是负责人';
  if (s.type === 'requirement') {
    const [a] = await tx
      .select({ id: requirementAssignments.id })
      .from(requirementAssignments)
      .where(and(eq(requirementAssignments.requirementId, s.id), eq(requirementAssignments.memberId, memberId)))
      .limit(1);
    if (a) return '你被分配到这条需求';
  }
  const [c] = await tx
    .select({ id: comments.id })
    .from(comments)
    .where(and(eq(comments.targetType, s.type), eq(comments.targetId, s.id), eq(comments.authorMemberId, memberId)))
    .limit(1);
  if (c) return '你评论过';
  return '你曾负责、被分配、评论或被 @';
}

async function viewTx(tx: Tx, memberId: string, s: SubscriptionSubject, ownerMemberId: string | null): Promise<SubscriptionView> {
  const [row] = await tx
    .select()
    .from(S)
    .where(and(eq(S.memberId, memberId), eq(S.subjectType, s.type), eq(S.subjectId, s.id)));
  if (!row || row.mutedAt) return { following: false, source: row?.source ?? null, reason: null };
  return { following: true, source: row.source, reason: await reasonTx(tx, memberId, s, row.source, ownerMemberId) };
}

export async function getSubscription(db: Db, actor: Actor, s: SubscriptionSubject): Promise<SubscriptionView> {
  return withOrg(db, actor.orgId, async (tx) => {
    const subj = await loadSubjectTx(tx, s);
    await requireProductRole(tx, actor, subj.productId, 'viewer');
    return viewTx(tx, actor.memberId, s, subj.ownerMemberId);
  });
}

/** 关注或取消关注。取消关注不删行，只记 muted_at，自动关注不会加回；再次关注改为手动。 */
export async function setSubscription(db: Db, actor: Actor, s: SubscriptionSubject, following: boolean): Promise<SubscriptionView> {
  if (actor.tokenScope?.access === 'read') throw new AppError('forbidden', '只读 Token 不能修改关注');
  return withOrg(db, actor.orgId, async (tx) => {
    const subj = await loadSubjectTx(tx, s);
    await requireProductRole(tx, actor, subj.productId, 'viewer');
    const now = new Date();
    await tx
      .insert(S)
      .values({ orgId: actor.orgId, memberId: actor.memberId, subjectType: s.type, subjectId: s.id, source: 'manual', mutedAt: following ? null : now })
      .onConflictDoUpdate({
        target: [S.memberId, S.subjectType, S.subjectId],
        set: following ? { source: 'manual', mutedAt: null } : { mutedAt: sql`coalesce(${S.mutedAt}, ${now.toISOString()}::timestamptz)` },
      });
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: subj.productId,
      type: following ? 'subscription.followed' : 'subscription.unfollowed',
      subjectType: s.type,
      subjectId: s.id,
      actor,
      payload: {},
    });
    return viewTx(tx, actor.memberId, s, subj.ownerMemberId);
  });
}

/** 后台生成通知时补上自动关注（不记事件）；已有的行（含已取消关注的）保持不变。 */
export async function autoSubscribeTx(tx: Tx, orgId: string, s: SubscriptionSubject, memberIds: string[]): Promise<void> {
  const unique = [...new Set(memberIds)];
  if (unique.length === 0) return;
  await tx
    .insert(S)
    .values(unique.map((memberId) => ({ orgId, memberId, subjectType: s.type, subjectId: s.id, source: 'auto' as const })))
    .onConflictDoNothing();
}
