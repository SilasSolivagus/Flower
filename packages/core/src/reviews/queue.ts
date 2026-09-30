import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { requireProductRole } from '../access/permissions';
import type { Db } from '../db/client';
import { products, requirements } from '../db/schema';
import { withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { type StateInfo, stateInfoByProduct, stateOf } from '../iterations/iterations';
import { memberNames, productWorkflowBody } from '../requirements/context';
import type { CheckState } from '../requirements/labels';
import { displayKey, type MemberRef } from '../requirements/requirements';
import { type ReviewState, reviewStateOf, signoffProgress } from '../requirements/workflow-runtime';
import { checkSnapshots, signerIdentity, waitingFor } from './snapshot';

export const REVIEW_FILTER_STATES = ['open', 'all', 'not_started', 'in_progress', 'rejected', 'passed'] as const;
export type ReviewFilterState = (typeof REVIEW_FILTER_STATES)[number];
export type ReviewQueueFilter = { state?: ReviewFilterState; itemKey?: string; itemState?: CheckState; waitingForMe?: boolean };
export type ReviewCell = { state: CheckState; passed: number | null; total: number | null };
export type ReviewWaiting = { itemKey: string; ruleIndex: number; onBehalf: boolean };
export type ReviewRow = {
  id: string;
  displayKey: string;
  title: string;
  state: StateInfo;
  owner: MemberRef | null;
  reviewState: ReviewState;
  cells: Record<string, ReviewCell>;
  waiting: ReviewWaiting[];
};
export type ReviewQueue = {
  columns: Array<{ key: string; label: string; type: 'single' | 'signoff' }>;
  stats: Record<ReviewState, number>;
  rows: ReviewRow[];
};

/**
 * 批量评审表：产品内未完成（状态类别不是已完成 / 已取消）的需求，每个需求检查项一列。
 * 统计覆盖全部未完成需求；state 默认 open（整体评审状态不是已通过）。
 */
export async function listReviewQueue(db: Db, actor: Actor, productId: string, filter: ReviewQueueFilter = {}): Promise<ReviewQueue> {
  return withOrg(db, actor.orgId, async (tx) => {
    const role = await requireProductRole(tx, actor, productId, 'viewer');
    const body = await productWorkflowBody(tx, productId);
    const items = body.checkItems.filter((c) => c.scope === 'requirement');
    const columns = items.map((c) => ({ key: c.key, label: c.label, type: c.type }));
    const stats: Record<ReviewState, number> = { not_started: 0, in_progress: 0, rejected: 0, passed: 0 };
    const openKeys = body.states.filter((s) => s.category !== 'completed' && s.category !== 'canceled').map((s) => s.key);
    if (items.length === 0 || openKeys.length === 0) return { columns, stats, rows: [] };

    const reqRows = await tx
      .select()
      .from(requirements)
      .where(and(eq(requirements.productId, productId), isNull(requirements.deletedAt), inArray(requirements.stateKey, openKeys)))
      .orderBy(desc(requirements.number));
    const snaps = await checkSnapshots(tx, body, reqRows.map((r) => r.id));
    const who = await signerIdentity(tx, actor, role);
    const canSign = actor.tokenScope?.access !== 'read';
    const [product] = await tx.select({ key: products.key }).from(products).where(eq(products.id, productId));
    const info = await stateInfoByProduct(tx, [productId]);
    const names = await memberNames(tx, reqRows.map((r) => r.ownerMemberId));

    const all: ReviewRow[] = reqRows.map((r) => {
      const snap = snaps.get(r.id)!;
      const cells: Record<string, ReviewCell> = {};
      for (const c of items) {
        const state = snap.states[c.key]!;
        const progress = c.type === 'signoff' ? signoffProgress(c, snap.signoffs.get(c.key) ?? []) : null;
        cells[c.key] = { state, passed: progress?.passed ?? null, total: progress?.total ?? null };
      }
      return {
        id: r.id,
        displayKey: displayKey(product!.key, r.number),
        title: r.title,
        state: stateOf(info, productId, r.stateKey),
        owner: r.ownerMemberId ? { id: r.ownerMemberId, displayName: names.get(r.ownerMemberId) ?? '已删除的成员' } : null,
        reviewState: reviewStateOf(items.map((c) => snap.states[c.key]!)),
        cells,
        waiting: canSign ? waitingFor(items, snap, who, role === 'admin') : [],
      };
    });
    for (const r of all) stats[r.reviewState] += 1;
    const state = filter.state ?? 'open';
    const rows = all.filter(
      (r) =>
        (state === 'all' || (state === 'open' ? r.reviewState !== 'passed' : r.reviewState === state)) &&
        (!filter.itemKey || !filter.itemState || r.cells[filter.itemKey]?.state === filter.itemState) &&
        (!filter.waitingForMe || r.waiting.length > 0),
    );
    return { columns, stats, rows };
  });
}
