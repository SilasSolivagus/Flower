import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { domainEvents, documents } from '../db/schema';
import type { Tx } from '../db/tx';
import type { DocumentStatus } from '../documents/constants';
import { documentDisplayKey } from '../documents/markdown';

/** 需求详情里的一份变更 PRD。current 当且仅当 id 等于 requirements.change_document_id。 */
export type ChangeDocumentHistoryItem = {
  id: string;
  displayKey: string;
  title: string;
  status: DocumentStatus;
  source: 'native' | 'external';
  current: boolean;
  /** 最近一次挂上的时间。只有 requirement.updated 里 field=changeDocumentId 且 new 为该 id 时才有；没有挂载事件则省略。 */
  linkedAt?: Date;
};

export type ChangeDocumentEvent = {
  occurredAt: Date;
  payload: Record<string, unknown>;
};

export type ChangeDocumentRow = {
  id: string;
  displayKey: string;
  title: string;
  status: DocumentStatus;
  source: 'native' | 'external';
};

/**
 * 从本需求的 requirement.updated（changes[].field === changeDocumentId）重建挂过的变更 PRD。
 *
 * 去重按文档 id。linkedAt 取该 id 最近一次作为 new 出现的事件时间；只在 old 里出现、或只有当前外键时省略。
 * 排序：当前挂载置顶，其余按 linkedAt 从新到旧；没有 linkedAt 的排在有时间的后面，彼此按 id。
 * 调用方传入的 documents 应已去掉已删除和查不到的行：那些 id 直接略去，不报错。
 *
 * 已知债：迁移或直接写外键、没有上述事件时，列表只有当前这一份，不能当作完整历史。
 * 事件按 occurredAt 升序处理（同一时刻保持传入顺序，查询侧再用 id 打破平局）。
 */
export function assembleChangeDocuments(input: {
  changeDocumentId: string | null;
  events: ChangeDocumentEvent[];
  documents: ChangeDocumentRow[];
}): ChangeDocumentHistoryItem[] {
  const byId = new Map(input.documents.map((doc) => [doc.id, doc]));
  const linkedAt = new Map<string, Date>();
  const seen = new Set<string>();
  const ordered = input.events.map((event, index) => ({ event, index })).sort((a, b) => a.event.occurredAt.getTime() - b.event.occurredAt.getTime() || a.index - b.index);
  for (const { event } of ordered) {
    for (const change of changeDocumentChanges(event.payload)) {
      const prev = asDocId(change.old);
      const next = asDocId(change.new);
      if (prev) seen.add(prev);
      if (next) {
        seen.add(next);
        linkedAt.set(next, event.occurredAt);
      }
    }
  }
  if (input.changeDocumentId) seen.add(input.changeDocumentId);

  const items: ChangeDocumentHistoryItem[] = [];
  for (const id of seen) {
    const doc = byId.get(id);
    if (!doc) continue;
    const at = linkedAt.get(id);
    items.push({
      id: doc.id,
      displayKey: doc.displayKey,
      title: doc.title,
      status: doc.status,
      source: doc.source,
      current: id === input.changeDocumentId,
      ...(at ? { linkedAt: at } : {}),
    });
  }
  items.sort(byCurrentThenRecent);
  return items;
}

/** 读本需求的挂载事件和仍存在的文档，组装 changeDocuments。不写库。 */
export async function loadChangeDocuments(tx: Tx, requirement: { id: string; changeDocumentId: string | null }, productKey: string): Promise<ChangeDocumentHistoryItem[]> {
  const events = await tx
    .select({ occurredAt: domainEvents.occurredAt, payload: domainEvents.payload })
    .from(domainEvents)
    .where(and(eq(domainEvents.subjectType, 'requirement'), eq(domainEvents.subjectId, requirement.id), eq(domainEvents.type, 'requirement.updated')))
    .orderBy(asc(domainEvents.occurredAt), asc(domainEvents.id));
  const ids = new Set<string>();
  if (requirement.changeDocumentId) ids.add(requirement.changeDocumentId);
  for (const event of events) {
    for (const change of changeDocumentChanges(event.payload)) {
      const prev = asDocId(change.old);
      const next = asDocId(change.new);
      if (prev) ids.add(prev);
      if (next) ids.add(next);
    }
  }
  if (ids.size === 0) return [];
  const rows = await tx
    .select({ id: documents.id, number: documents.number, title: documents.title, status: documents.status, source: documents.source })
    .from(documents)
    .where(and(inArray(documents.id, [...ids]), isNull(documents.deletedAt)));
  return assembleChangeDocuments({
    changeDocumentId: requirement.changeDocumentId,
    events,
    documents: rows.map((doc) => ({
      id: doc.id,
      displayKey: documentDisplayKey(productKey, doc.number),
      title: doc.title,
      status: doc.status,
      source: doc.source,
    })),
  });
}

function changeDocumentChanges(payload: Record<string, unknown>): Array<{ old: unknown; new: unknown }> {
  const changes = payload.changes;
  if (!Array.isArray(changes)) return [];
  const out: Array<{ old: unknown; new: unknown }> = [];
  for (const change of changes) {
    if (!change || typeof change !== 'object') continue;
    if ((change as { field?: unknown }).field !== 'changeDocumentId') continue;
    out.push({ old: (change as { old?: unknown }).old, new: (change as { new?: unknown }).new });
  }
  return out;
}

function asDocId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function byCurrentThenRecent(a: ChangeDocumentHistoryItem, b: ChangeDocumentHistoryItem): number {
  if (a.current !== b.current) return a.current ? -1 : 1;
  const at = a.linkedAt?.getTime();
  const bt = b.linkedAt?.getTime();
  if (at !== undefined && bt !== undefined && at !== bt) return bt - at;
  if (at !== undefined && bt === undefined) return -1;
  if (at === undefined && bt !== undefined) return 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
