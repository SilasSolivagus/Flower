import { and, asc, desc, eq, gte, inArray, isNull, lte, ne } from 'drizzle-orm';
import { iterationScopeSnapshots, iterations, releases } from '../db/schema';
import type { Tx } from '../db/tx';
import type { IterationStatus } from '../iterations/iterations';
import type { IterationFact, ReleaseFact, SpecialFact } from './delivery-metrics';
import type { ProductFlow } from './flow';

export type IterationOption = { id: string; name: string; startDate: string; endDate: string; status: IterationStatus };

const iterationColumns = { id: iterations.id, name: iterations.name, startDate: iterations.startDate, endDate: iterations.endDate, status: iterations.status };

/** 本产品的全部发布版本；所属迭代未删除时带出它的结束日（版本没有基线日期时用它判断是否按期）。 */
export async function loadReleaseFacts(tx: Tx, productId: string): Promise<ReleaseFact[]> {
  return tx
    .select({
      id: releases.id,
      versionName: releases.versionName,
      status: releases.status,
      plannedDate: releases.plannedDate,
      baselineDate: releases.baselineDate,
      releasedAt: releases.releasedAt,
      iterationEndDate: iterations.endDate,
    })
    .from(releases)
    .leftJoin(iterations, and(eq(iterations.id, releases.iterationId), isNull(iterations.deletedAt)))
    .where(eq(releases.productId, productId));
}

/** 本产品与时间段有交集、已开始（进行中或已完成）的常规迭代，开始日倒序；带承诺范围快照与当前范围。 */
export async function loadIterationFacts(tx: Tx, productId: string, flow: ProductFlow, from: string, to: string): Promise<IterationFact[]> {
  const rows = await tx
    .select(iterationColumns)
    .from(iterations)
    .where(
      and(
        eq(iterations.productId, productId),
        eq(iterations.type, 'regular'),
        isNull(iterations.deletedAt),
        inArray(iterations.status, ['active', 'done']),
        lte(iterations.startDate, to),
        gte(iterations.endDate, from),
      ),
    )
    .orderBy(desc(iterations.startDate));
  if (rows.length === 0) return [];
  const snaps = await tx
    .select({ iterationId: iterationScopeSnapshots.iterationId, requirementId: iterationScopeSnapshots.requirementId })
    .from(iterationScopeSnapshots)
    .where(and(inArray(iterationScopeSnapshots.iterationId, rows.map((r) => r.id)), eq(iterationScopeSnapshots.snapshotKind, 'committed')));
  const metas = [...flow.meta.values()];
  return rows.map((r) => ({
    ...r,
    status: r.status as 'active' | 'done',
    snapshotTaken: snaps.some((s) => s.iterationId === r.id),
    committedIds: snaps.filter((s) => s.iterationId === r.id).map((s) => s.requirementId),
    currentIds: metas.filter((m) => m.iterationId === r.id).map((m) => m.id),
  }));
}

/** 与时间段有交集的专项（专项属于组织）；只带本产品未删除需求的状态，不含本产品需求的专项不返回。 */
export async function loadSpecialFacts(tx: Tx, flow: ProductFlow, from: string, to: string): Promise<SpecialFact[]> {
  const rows = await tx
    .select(iterationColumns)
    .from(iterations)
    .where(and(eq(iterations.type, 'special'), isNull(iterations.deletedAt), lte(iterations.startDate, to), gte(iterations.endDate, from)))
    .orderBy(desc(iterations.startDate), asc(iterations.name));
  const metas = [...flow.meta.values()];
  return rows
    .map((r) => ({ ...r, stateKeys: metas.filter((m) => m.iterationId === r.id).map((m) => m.stateKey) }))
    .filter((s) => s.stateKeys.length > 0);
}

/** 「按迭代」可选的迭代：本产品已到开始日、未取消、未删除的常规迭代，开始日倒序。 */
export async function loadIterationOptions(tx: Tx, productId: string, today: string): Promise<IterationOption[]> {
  return tx
    .select(iterationColumns)
    .from(iterations)
    .where(
      and(
        eq(iterations.productId, productId),
        eq(iterations.type, 'regular'),
        isNull(iterations.deletedAt),
        ne(iterations.status, 'canceled'),
        lte(iterations.startDate, today),
      ),
    )
    .orderBy(desc(iterations.startDate));
}
