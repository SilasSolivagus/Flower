import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { productRoleOf, visibleProductIds } from '../access/permissions';
import type { Db } from '../db/client';
import { comments, documents, entityLinks, products, requirements, tasks } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import { documentDisplayKey } from '../documents/markdown';
import type { Actor, ProductRole } from '../domain-types';
import { AppError } from '../errors';
import { loadVisibleIteration } from '../iterations/iterations';
import { displayKey as requirementDisplayKey } from '../requirements/requirements';

export const BACKLINK_TARGET_TYPES = ['requirement', 'document', 'task', 'iteration'] as const;
export type BacklinkTargetType = (typeof BACKLINK_TARGET_TYPES)[number];
export type BacklinkItem = { via: 'description' | 'body' | 'comment'; section: string | null; context: string; createdAt: Date };
export type BacklinkGroup = { kind: 'requirement' | 'document'; id: string; displayKey: string; title: string; href: string; items: BacklinkItem[] };

const NOT_FOUND = { requirement: '需求不存在', document: 'PRD 不存在', task: '任务不存在' } as const;

/** 目标不存在或看不到时与不存在一样返回 404。 */
async function assertTargetVisible(tx: Tx, actor: Actor, target: { type: BacklinkTargetType; id: string }): Promise<void> {
  if (target.type === 'iteration') {
    await loadVisibleIteration(tx, target.id, await visibleProductIds(tx, actor));
    return;
  }
  const [row] =
    target.type === 'requirement'
      ? await tx.select({ productId: requirements.productId }).from(requirements).where(and(eq(requirements.id, target.id), isNull(requirements.deletedAt)))
      : target.type === 'document'
        ? await tx.select({ productId: documents.productId }).from(documents).where(and(eq(documents.id, target.id), isNull(documents.deletedAt)))
        : await tx.select({ productId: tasks.productId }).from(tasks).where(eq(tasks.id, target.id));
  if (!row || !(await productRoleOf(tx, actor, row.productId))) throw new AppError('not_found', NOT_FOUND[target.type]);
}

/**
 * 「被引用」：手写的 [[ ]] 链接，按来源对象（需求或 PRD；评论归到它所在的对象）分组，组与条目按时间倒序。
 * 不列对象引用自己（如需求描述或需求评论里写了这条需求本身）；来源对象已删除，或查看者看不到来源所在产品时不列。
 */
export async function listBacklinks(db: Db, actor: Actor, target: { type: BacklinkTargetType; id: string }): Promise<BacklinkGroup[]> {
  return withOrg(db, actor.orgId, async (tx) => {
    await assertTargetVisible(tx, actor, target);
    const rows = await tx
      .select()
      .from(entityLinks)
      .where(and(eq(entityLinks.targetType, target.type), eq(entityLinks.targetId, target.id), eq(entityLinks.origin, 'wikilink')))
      .orderBy(desc(entityLinks.createdAt), desc(entityLinks.id));
    const commentIds = rows.filter((r) => r.sourceType === 'comment').map((r) => r.sourceId);
    const commentRows =
      commentIds.length > 0
        ? await tx.select({ id: comments.id, targetType: comments.targetType, targetId: comments.targetId }).from(comments).where(inArray(comments.id, commentIds))
        : [];
    const parentOf = new Map(commentRows.map((c) => [c.id, c]));
    const refs: Array<{ kind: 'requirement' | 'document'; id: string; item: BacklinkItem }> = [];
    for (const r of rows) {
      const item = { section: r.sourceSection, context: r.context, createdAt: r.createdAt };
      if (r.sourceType === 'comment') {
        const c = parentOf.get(r.sourceId);
        if (c && (c.targetType === 'requirement' || c.targetType === 'document')) refs.push({ kind: c.targetType, id: c.targetId, item: { via: 'comment', ...item } });
      } else {
        refs.push({ kind: r.sourceType, id: r.sourceId, item: { via: r.sourceType === 'requirement' ? 'description' : 'body', ...item } });
      }
    }
    const reqIds = [...new Set(refs.filter((x) => x.kind === 'requirement').map((x) => x.id))];
    const docIds = [...new Set(refs.filter((x) => x.kind === 'document').map((x) => x.id))];
    const reqRows = reqIds.length > 0 ? await tx.select().from(requirements).where(and(inArray(requirements.id, reqIds), isNull(requirements.deletedAt))) : [];
    const docRows = docIds.length > 0 ? await tx.select().from(documents).where(and(inArray(documents.id, docIds), isNull(documents.deletedAt))) : [];
    const keyOf = new Map((await tx.select({ id: products.id, key: products.key }).from(products)).map((p) => [p.id, p.key]));
    const roles = new Map<string, ProductRole | null>();
    const canSee = async (pid: string): Promise<boolean> => {
      if (!roles.has(pid)) roles.set(pid, await productRoleOf(tx, actor, pid));
      return roles.get(pid) !== null;
    };
    const heads = new Map<string, Omit<BacklinkGroup, 'items'>>();
    for (const r of reqRows) {
      if (!(await canSee(r.productId))) continue;
      const key = requirementDisplayKey(keyOf.get(r.productId)!, r.number);
      heads.set(`requirement:${r.id}`, { kind: 'requirement', id: r.id, displayKey: key, title: r.title, href: `requirements/${key}` });
    }
    for (const d of docRows) {
      if (!(await canSee(d.productId))) continue;
      const key = documentDisplayKey(keyOf.get(d.productId)!, d.number);
      heads.set(`document:${d.id}`, { kind: 'document', id: d.id, displayKey: key, title: d.title, href: `documents/${key}` });
    }
    const groups = new Map<string, BacklinkGroup>();
    for (const ref of refs) {
      if (ref.kind === target.type && ref.id === target.id) continue;
      const k = `${ref.kind}:${ref.id}`;
      const head = heads.get(k);
      if (!head) continue;
      const g = groups.get(k) ?? { ...head, items: [] };
      g.items.push(ref.item);
      groups.set(k, g);
    }
    return [...groups.values()];
  });
}
