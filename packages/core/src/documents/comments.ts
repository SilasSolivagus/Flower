import { and, asc, eq, inArray } from 'drizzle-orm';
import { requireProductRole } from '../access/permissions';
import { markCommentsRead } from '../comments/reads';
import type { Db } from '../db/client';
import { commentReads, comments, documentRevisions } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import { type LinkCard, linkCardsFor, sourceKey } from '../links/cards';
import { syncSourceLinks } from '../links/links';
import { memberNames } from '../requirements/context';
import { type MemberRef, productKeyOf } from '../requirements/requirements';
import type { TextAnchor } from './constants';
import { loadDocument } from './documents';
import { locateQuote } from './markdown';

export type DocumentCommentView = {
  id: string;
  parentId: string | null;
  author: MemberRef | null;
  body: string;
  anchor: TextAnchor | null;
  anchorState: 'ok' | 'stale' | 'unanchored' | null;
  resolvedAt: Date | null;
  resolvedBy: MemberRef | null;
  createdAt: Date;
  links: LinkCard[];
};
type CommentRow = typeof comments.$inferSelect;

const onDocument = (documentId: string) => and(eq(comments.targetType, 'document'), eq(comments.targetId, documentId));

async function views(tx: Tx, actor: Actor, rows: CommentRow[]): Promise<DocumentCommentView[]> {
  const names = await memberNames(tx, rows.flatMap((r) => [r.authorMemberId, r.resolvedBy]));
  const cards = await linkCardsFor(tx, actor, rows.map((c) => ({ type: 'comment' as const, id: c.id })));
  const ref = (id: string | null): MemberRef | null => (id ? { id, displayName: names.get(id) ?? '已删除的成员' } : null);
  return rows.map((c) => ({
    id: c.id,
    parentId: c.parentId,
    author: ref(c.authorMemberId),
    body: c.body,
    anchor: (c.anchor as TextAnchor | null) ?? null,
    anchorState: c.anchorState,
    resolvedAt: c.resolvedAt,
    resolvedBy: ref(c.resolvedBy),
    createdAt: c.createdAt,
    links: cards.get(sourceKey('comment', c.id))!,
  }));
}

export async function listDocumentComments(db: Db, actor: Actor, documentId: string): Promise<DocumentCommentView[]> {
  return withOrg(db, actor.orgId, async (tx) => {
    const doc = await loadDocument(tx, documentId);
    await requireProductRole(tx, actor, doc.productId, 'viewer');
    const rows = await tx.select().from(comments).where(onDocument(documentId)).orderBy(asc(comments.createdAt), asc(comments.id));
    return views(tx, actor, rows);
  });
}

export async function addDocumentComment(
  db: Db,
  actor: Actor,
  documentId: string,
  input: { body: string; parentId?: string | null; anchor?: { quote: string; prefix?: string; suffix?: string } | null },
): Promise<DocumentCommentView> {
  if (actor.tokenScope?.access === 'read') throw new AppError('forbidden', '只读 Token 不能评论');
  const body = input.body.trim();
  if (!body || body.length > 10_000) throw new AppError('invalid', '评论不能为空，且不超过 10000 个字符');
  return withOrg(db, actor.orgId, async (tx) => {
    const doc = await loadDocument(tx, documentId);
    await requireProductRole(tx, actor, doc.productId, 'viewer');
    if (input.parentId) {
      const [parent] = await tx.select({ id: comments.id }).from(comments).where(and(eq(comments.id, input.parentId), onDocument(documentId)));
      if (!parent) throw new AppError('invalid', '回复的评论不存在');
    }
    let anchor: TextAnchor | null = null;
    if (input.anchor) {
      if (input.parentId) throw new AppError('invalid', '回复不能再选择原文');
      if (doc.source !== 'native' || !doc.currentRevisionId) throw new AppError('invalid', '外部 PRD 不能划词评论');
      const quote = input.anchor.quote.trim();
      if (!quote || quote.length > 500) throw new AppError('invalid', '选中的文字不能为空，且不超过 500 个字符');
      const prefix = (input.anchor.prefix ?? '').slice(-64);
      const suffix = (input.anchor.suffix ?? '').slice(0, 64);
      const [rev] = await tx.select().from(documentRevisions).where(eq(documentRevisions.id, doc.currentRevisionId));
      const found = locateQuote(rev!.snapshot.markdown, { quote, prefix, suffix });
      if (!found) throw new AppError('invalid', '所选文字在当前版本中找不到，请刷新后重新选择');
      anchor = { quote, prefix, suffix, sectionHeading: found.sectionHeading };
    }
    const [row] = await tx
      .insert(comments)
      .values({
        orgId: actor.orgId,
        targetType: 'document',
        targetId: documentId,
        parentId: input.parentId ?? null,
        authorMemberId: actor.memberId,
        body,
        kind: 'comment',
        anchor,
        anchorState: anchor ? 'ok' : null,
      })
      .returning();
    await tx.insert(commentReads).values({ orgId: actor.orgId, commentId: row!.id, memberId: actor.memberId });
    await syncSourceLinks(tx, actor.orgId, { type: 'comment', id: row!.id, productKey: await productKeyOf(tx, doc.productId) }, body);
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: doc.productId,
      type: 'comment.created',
      subjectType: 'document',
      subjectId: documentId,
      actor,
      payload: { commentId: row!.id, anchored: anchor !== null },
    });
    return (await views(tx, actor, [row!]))[0]!;
  });
}

export async function setDocumentCommentResolved(db: Db, actor: Actor, commentId: string, input: { resolved: boolean }): Promise<DocumentCommentView> {
  if (actor.tokenScope?.access === 'read') throw new AppError('forbidden', '只读 Token 不能修改评论');
  return withOrg(db, actor.orgId, async (tx) => {
    const [c] = await tx.select().from(comments).where(and(eq(comments.id, commentId), eq(comments.targetType, 'document')));
    if (!c) throw new AppError('not_found', '评论不存在');
    const doc = await loadDocument(tx, c.targetId);
    const role = await requireProductRole(tx, actor, doc.productId, 'viewer');
    if (role === 'viewer' && c.authorMemberId !== actor.memberId) throw new AppError('forbidden', '只能解决自己发的评论，其他评论由产品编辑处理');
    if (c.parentId) throw new AppError('invalid', '只能解决顶层评论');
    const [row] = await tx
      .update(comments)
      .set(input.resolved ? { resolvedAt: new Date(), resolvedBy: actor.memberId } : { resolvedAt: null, resolvedBy: null })
      .where(eq(comments.id, commentId))
      .returning();
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: doc.productId,
      type: input.resolved ? 'comment.resolved' : 'comment.reopened',
      subjectType: 'document',
      subjectId: doc.id,
      actor,
      payload: { commentId, changes: [{ field: 'resolved', old: !input.resolved, new: input.resolved }] },
    });
    return (await views(tx, actor, [row!]))[0]!;
  });
}

/**
 * 正文变化后重新定位划词评论：找到原文时为 ok 并更新所在小节，找不到时为 stale（不删除）。
 * 迁移导入的 unanchored 评论与整篇评论不处理。在保存或恢复修订的同一事务里调用。
 */
export async function reanchorDocumentComments(tx: Tx, documentId: string, markdown: string): Promise<number> {
  const rows = await tx
    .select({ id: comments.id, anchor: comments.anchor, anchorState: comments.anchorState })
    .from(comments)
    .where(and(onDocument(documentId), inArray(comments.anchorState, ['ok', 'stale'])));
  let changed = 0;
  for (const r of rows) {
    const anchor = r.anchor as TextAnchor;
    const found = locateQuote(markdown, anchor);
    const next = found ? { anchorState: 'ok' as const, anchor: { ...anchor, sectionHeading: found.sectionHeading } } : { anchorState: 'stale' as const, anchor };
    if (next.anchorState === r.anchorState && next.anchor.sectionHeading === anchor.sectionHeading) continue;
    await tx.update(comments).set(next).where(eq(comments.id, r.id));
    changed += 1;
  }
  return changed;
}

/** 打开 PRD 详情时把它的全部评论标为已读（与需求详情一致）；只读 Token 不能标记。 */
export async function markDocumentCommentsRead(db: Db, actor: Actor, documentId: string): Promise<number> {
  if (actor.tokenScope?.access === 'read') throw new AppError('forbidden', '只读 Token 不能标记已读');
  return withOrg(db, actor.orgId, async (tx) => {
    const doc = await loadDocument(tx, documentId);
    await requireProductRole(tx, actor, doc.productId, 'viewer');
    return markCommentsRead(tx, actor, { type: 'document', id: documentId });
  });
}
