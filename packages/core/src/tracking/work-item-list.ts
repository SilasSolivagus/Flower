/**
 * 工作项列表与批量改状态（M6-003 / M6-012）。
 * 可见范围与跟进相同；已完成、已取消只要参数打开就返回，不套跟进的 30 天窗口。
 * 批量逐条鉴权、各自提交，已处于目标状态算成功，便于部分失败后重试。
 */
import { and, desc, eq, inArray, isNotNull, isNull, or, type SQL, sql } from 'drizzle-orm';
import { atLeast, productRoleOf, visibleProductIds } from '../access/permissions';
import type { Db } from '../db/client';
import { blockers, products, progressUpdates, workItems } from '../db/schema';
import { withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError } from '../errors';
import { workItemDisplayKey } from '../links/syntax';
import { memberNames } from '../requirements/context';
import type { MemberRef } from '../requirements/requirements';
import { canViewUnlinked, canWriteUnlinked } from './access';
import { setWorkItemStatus, WORK_ITEM_STATUS_LABELS, type WorkItemStatus } from './work-items';

const STAGE_COLOR: Record<WorkItemStatus, string> = { active: '#f59e0b', done: '#10b981', canceled: '#9ca3af' };
const STAGE_CATEGORY: Record<WorkItemStatus, string> = { active: 'started', done: 'completed', canceled: 'canceled' };

export const WORK_ITEM_LIST_DEFAULT_LIMIT = 200;
export const WORK_ITEM_LIST_MAX_LIMIT = 500;
export const WORK_ITEM_BATCH_MAX = 50;
/** 跨租户、无权、不存在统一成这一句，避免泄露别的组织里有没有这条。 */
export const WORK_ITEM_BATCH_HIDDEN = '无权或不存在';

export type WorkItemListFilter = {
  productId?: string;
  ownerId?: string;
  paused?: boolean;
  blocked?: boolean;
  includeDone?: boolean;
  includeCanceled?: boolean;
  limit?: number;
};

export type WorkItemListItem = {
  id: string;
  displayKey: string;
  title: string;
  stage: { key: WorkItemStatus; label: string; color: string; category: string };
  owner: MemberRef | null;
  product: { id: string; key: string; name: string } | null;
  latest: { createdAt: Date } | null;
  canWrite: boolean;
};

export type WorkItemBatchResult = { updated: number; failed: Array<{ id: string; reason: string }> };

function statusesOf(filter: WorkItemListFilter): WorkItemStatus[] {
  const statuses: WorkItemStatus[] = ['active'];
  if (filter.includeDone) statuses.push('done');
  if (filter.includeCanceled) statuses.push('canceled');
  return statuses;
}

function assertLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1) throw new AppError('invalid', '查询条数无效');
  if (limit > WORK_ITEM_LIST_MAX_LIMIT) throw new AppError('invalid', '一次最多查询 500 条');
  return limit;
}

export async function listWorkItems(db: Db, actor: Actor, filter: WorkItemListFilter = {}): Promise<WorkItemListItem[]> {
  const limit = assertLimit(filter.limit ?? WORK_ITEM_LIST_DEFAULT_LIMIT);
  return withOrg(db, actor.orgId, async (tx) => {
    const visible = [...(await visibleProductIds(tx, actor))];
    const scope = filter.productId ? visible.filter((id) => id === filter.productId) : visible;
    const unlinked = !filter.productId && canViewUnlinked(actor);
    if (scope.length === 0 && !unlinked) return [];

    const where: SQL[] = [isNull(workItems.deletedAt), inArray(workItems.status, statusesOf(filter))];
    const placed = scope.length > 0 && unlinked ? or(inArray(workItems.productId, scope), isNull(workItems.productId)) : scope.length > 0 ? inArray(workItems.productId, scope) : isNull(workItems.productId);
    if (placed) where.push(placed);
    if (filter.ownerId) where.push(eq(workItems.ownerMemberId, filter.ownerId));
    if (filter.paused) where.push(isNotNull(workItems.pausedAt));
    if (filter.blocked) {
      where.push(sql`exists (select 1 from ${blockers} where ${blockers.workItemId} = ${workItems.id} and ${blockers.status} = 'active')`);
    }

    const rows = await tx.select().from(workItems).where(and(...where)).orderBy(desc(workItems.number)).limit(limit);
    if (rows.length === 0) return [];
    const productIds = [...new Set(rows.flatMap((r) => (r.productId ? [r.productId] : [])))];
    const productRows = productIds.length
      ? await tx.select({ id: products.id, key: products.key, name: products.name }).from(products).where(inArray(products.id, productIds))
      : [];
    const productById = new Map(productRows.map((p) => [p.id, p]));
    const roles = new Map<string, Awaited<ReturnType<typeof productRoleOf>>>();
    for (const id of productIds) roles.set(id, await productRoleOf(tx, actor, id));
    const progressRows = await tx
      .selectDistinctOn([progressUpdates.workItemId])
      .from(progressUpdates)
      .where(and(isNull(progressUpdates.deletedAt), inArray(progressUpdates.workItemId, rows.map((r) => r.id))))
      .orderBy(progressUpdates.workItemId, desc(progressUpdates.createdAt), desc(progressUpdates.id));
    const latest = new Map(progressRows.map((p) => [p.workItemId!, p]));
    const names = await memberNames(tx, rows.map((r) => r.ownerMemberId));

    return rows.map((w) => {
      const progress = latest.get(w.id);
      const status = w.status;
      return {
        id: w.id,
        displayKey: workItemDisplayKey(w.number),
        title: w.title,
        stage: { key: status, label: WORK_ITEM_STATUS_LABELS[status], color: STAGE_COLOR[status], category: STAGE_CATEGORY[status] },
        owner: w.ownerMemberId ? { id: w.ownerMemberId, displayName: names.get(w.ownerMemberId) ?? '已删除的成员' } : null,
        product: w.productId ? (productById.get(w.productId) ?? null) : null,
        latest: progress ? { createdAt: progress.createdAt } : null,
        canWrite: w.productId ? atLeast(roles.get(w.productId) ?? null, 'editor') : canWriteUnlinked(actor),
      };
    });
  });
}

function uniqueIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** 逐条改状态。超限在动手前拒绝；单条失败不影响已经改成的。 */
export async function batchSetWorkItemStatus(db: Db, actor: Actor, ids: string[], status: WorkItemStatus): Promise<WorkItemBatchResult> {
  if (ids.length > WORK_ITEM_BATCH_MAX) throw new AppError('invalid', '一次最多修改 50 条');
  if (status !== 'active' && status !== 'done' && status !== 'canceled') throw new AppError('invalid', '状态无效');
  let updated = 0;
  const failed: WorkItemBatchResult['failed'] = [];
  for (const id of uniqueIds(ids)) {
    try {
      await setWorkItemStatus(db, actor, id, status);
      updated += 1;
    } catch (e) {
      if (e instanceof AppError && e.message === '工作项已处于该状态') {
        updated += 1;
        continue;
      }
      if (e instanceof AppError && (e.code === 'not_found' || e.code === 'forbidden')) {
        failed.push({ id, reason: WORK_ITEM_BATCH_HIDDEN });
        continue;
      }
      if (e instanceof AppError) {
        failed.push({ id, reason: e.message });
        continue;
      }
      throw e;
    }
  }
  return { updated, failed };
}
