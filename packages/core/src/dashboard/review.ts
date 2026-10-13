import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { documents, domainEvents } from '../db/schema';
import type { Tx } from '../db/tx';
import type { ReviewEventFact } from './delivery-metrics';

const REVIEW_EVENT_TYPES = ['check_item.updated', 'check_item.signed'];

/** 事件 payload 里检查项状态的新值（changes 中 field 为 state 的 new）；没有改变状态的事件为 null。 */
export function stateChangeOf(payload: Record<string, unknown>): string | null {
  const changes = Array.isArray(payload.changes) ? (payload.changes as unknown[]) : [];
  for (const c of changes) {
    if (c && typeof c === 'object' && (c as { field?: unknown }).field === 'state') {
      const value = (c as { new?: unknown }).new;
      return typeof value === 'string' ? value : null;
    }
  }
  return null;
}

/**
 * 本产品的检查项事件（需求与 PRD 上的，含跟随 PRD 状态的自动更新），按发生时间升序。
 * 只保留对象仍存在的：需求须在 requirementIds（本产品未删除的需求）里，PRD 须未删除。
 * 迁移来的旧事件类型为 legacy.*，不在这里统计。
 */
export async function loadReviewEvents(tx: Tx, productId: string, requirementIds: Set<string>): Promise<ReviewEventFact[]> {
  const rows = await tx
    .select({ type: domainEvents.type, subjectType: domainEvents.subjectType, subjectId: domainEvents.subjectId, payload: domainEvents.payload, occurredAt: domainEvents.occurredAt })
    .from(domainEvents)
    .where(and(eq(domainEvents.productId, productId), inArray(domainEvents.type, REVIEW_EVENT_TYPES)))
    .orderBy(asc(domainEvents.occurredAt), asc(domainEvents.id));
  if (rows.length === 0) return [];
  const docs = await tx
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.productId, productId), isNull(documents.deletedAt)));
  const liveDocuments = new Set(docs.map((d) => d.id));
  const out: ReviewEventFact[] = [];
  for (const e of rows) {
    const live = e.subjectType === 'requirement' ? requirementIds.has(e.subjectId) : e.subjectType === 'document' && liveDocuments.has(e.subjectId);
    const itemKey = typeof e.payload.itemKey === 'string' ? e.payload.itemKey : null;
    if (!live || !itemKey) continue;
    out.push({
      subjectType: e.subjectType,
      subjectId: e.subjectId,
      itemKey,
      type: e.type,
      newState: stateChangeOf(e.payload),
      decision: typeof e.payload.decision === 'string' ? e.payload.decision : null,
      at: e.occurredAt,
    });
  }
  return out;
}
