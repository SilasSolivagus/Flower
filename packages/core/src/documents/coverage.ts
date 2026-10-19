import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { requireProductRole } from '../access/permissions';
import type { Db } from '../db/client';
import { checkItemResults, documents, products, requirements } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import { productWorkflowBody } from '../requirements/context';
import { displayKey, productKeyOf } from '../requirements/requirements';
import { prdAutoItem } from '../requirements/workflow-runtime';
import type { DocumentStatus } from './constants';
import { loadDocument } from './documents';
import { briefDisplayKey, documentDisplayKey, prdCheckState } from './markdown';

/** 把被覆盖需求的「PRD」检查项写成 PRD 状态对应的结果；流程里没有 auto 项时什么也不做。调用方已锁住文档与这些需求。 */
export async function syncPrdCheck(tx: Tx, actor: Actor, doc: { id: string; productId: string; status: DocumentStatus }, requirementIds: string[]): Promise<void> {
  if (requirementIds.length === 0) return;
  const item = prdAutoItem(await productWorkflowBody(tx, doc.productId));
  if (!item) return;
  const state = prdCheckState(doc.status);
  const now = new Date();
  for (const id of requirementIds) {
    const [existing] = await tx
      .select()
      .from(checkItemResults)
      .where(and(eq(checkItemResults.targetType, 'requirement'), eq(checkItemResults.targetId, id), eq(checkItemResults.itemKey, item.key)));
    const old = existing?.state ?? item.defaultState;
    if (old === state && existing) continue;
    if (existing) await tx.update(checkItemResults).set({ state, updatedBy: actor.memberId, updatedAt: now }).where(eq(checkItemResults.id, existing.id));
    else await tx.insert(checkItemResults).values({ orgId: actor.orgId, targetType: 'requirement', targetId: id, itemKey: item.key, state, updatedBy: actor.memberId, updatedAt: now });
    if (old === state) continue;
    await tx.update(requirements).set({ updatedAt: now }).where(eq(requirements.id, id));
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: doc.productId,
      type: 'check_item.updated',
      subjectType: 'requirement',
      subjectId: id,
      actor,
      payload: { itemKey: item.key, auto: true, documentId: doc.id, changes: [{ field: 'state', old, new: state }] },
    });
  }
}

type CoverageKind = 'change' | 'brief';
// noun 直接嵌在提示语里：PRD 前后各留一个空格，简报不留。
const COVERAGE = {
  change: { noun: ' PRD ', field: 'changeDocumentId', docKey: documentDisplayKey },
  brief: { noun: '简报', field: 'briefDocumentId', docKey: briefDisplayKey },
} as const;

/**
 * 在已有事务里把需求挂到 PRD（change_document_id）或简报（brief_document_id）上：先锁文档，再按 id 升序锁需求。
 * 已挂在这份文档上的跳过。只有变更 PRD 同步需求的「PRD」检查项。
 */
async function linkCoverageTx(tx: Tx, actor: Actor, kind: CoverageKind, documentId: string, requirementIds: string[]): Promise<{ linked: number }> {
  const cfg = COVERAGE[kind];
  const ids = [...new Set(requirementIds)].sort();
  if (ids.length === 0 || ids.length > 200) throw new AppError('invalid', '一次关联 1–200 条需求');
  const doc = await loadDocument(tx, documentId, { lock: true });
  await requireProductRole(tx, actor, doc.productId, 'editor');
  if (doc.kind !== kind) throw new AppError('invalid', doc.kind === 'module' ? '模块文档不关联需求' : doc.kind === 'brief' ? '简报的需求不能按 PRD 的方式关联' : '只有简报可以这样关联需求');
  if (doc.status === 'discarded') throw new AppError('invalid', `已废弃的${cfg.noun}不能再关联需求`);
  const rows = await tx
    .select()
    .from(requirements)
    .where(and(inArray(requirements.id, ids), isNull(requirements.deletedAt)))
    .orderBy(asc(requirements.id))
    .for('update');
  if (rows.length !== ids.length) throw new AppError('invalid', '需求不存在');
  const keyRows = await tx
    .select({ id: products.id, key: products.key })
    .from(products)
    .where(inArray(products.id, [...new Set([doc.productId, ...rows.map((r) => r.productId)])]));
  const keyOf = new Map(keyRows.map((k) => [k.id, k.key]));
  const productKey = keyOf.get(doc.productId) ?? '';
  const docKey = cfg.docKey(productKey, doc.number);
  for (const r of rows) {
    const reqKey = displayKey(keyOf.get(r.productId)!, r.number);
    if (r.productId !== doc.productId) throw new AppError('invalid', `${reqKey} 不属于这份${cfg.noun}所在的产品`);
    const attached = r[cfg.field];
    if (attached && attached !== doc.id) {
      const other = await loadDocument(tx, attached);
      throw new AppError('conflict', `${reqKey} 已挂在 ${cfg.docKey(productKey, other.number)} 上，请先从那份${cfg.noun}移出`);
    }
  }
  const fresh = rows.filter((r) => r[cfg.field] !== doc.id);
  if (fresh.length === 0) return { linked: 0 };
  const now = new Date();
  for (const r of fresh) {
    await tx.update(requirements).set({ [cfg.field]: doc.id, updatedAt: now }).where(eq(requirements.id, r.id));
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: doc.productId,
      type: 'requirement.updated',
      subjectType: 'requirement',
      subjectId: r.id,
      actor,
      payload: { changes: [{ field: cfg.field, old: null, new: doc.id }], [kind === 'brief' ? 'brief' : 'document']: docKey },
    });
  }
  if (kind === 'brief') await tx.update(documents).set({ updatedAt: now }).where(eq(documents.id, doc.id));
  await recordEvent(tx, {
    orgId: actor.orgId,
    productId: doc.productId,
    type: 'document.requirements_linked',
    subjectType: 'document',
    subjectId: doc.id,
    actor,
    payload: {
      requirementIds: fresh.map((r) => r.id),
      changes: [{ field: 'requirements', old: null, new: fresh.map((r) => displayKey(keyOf.get(r.productId)!, r.number)) }],
    },
  });
  if (kind === 'change') await syncPrdCheck(tx, actor, doc, fresh.map((r) => r.id));
  return { linked: fresh.length };
}

/** 把需求挂到变更 PRD 上。 */
export const linkRequirementsTx = (tx: Tx, actor: Actor, documentId: string, requirementIds: string[]) => linkCoverageTx(tx, actor, 'change', documentId, requirementIds);
/** 把需求挂到简报上。 */
export const linkBriefRequirementsTx = (tx: Tx, actor: Actor, documentId: string, requirementIds: string[]) => linkCoverageTx(tx, actor, 'brief', documentId, requirementIds);

/** 文档接口的「关联需求」：变更 PRD 写 change_document_id，简报写 brief_document_id。 */
export async function linkDocumentRequirements(db: Db, actor: Actor, documentId: string, input: { requirementIds: string[] }): Promise<{ linked: number }> {
  return withOrg(db, actor.orgId, async (tx) => {
    const [d] = await tx.select({ kind: documents.kind }).from(documents).where(eq(documents.id, documentId));
    return linkCoverageTx(tx, actor, d?.kind === 'brief' ? 'brief' : 'change', documentId, input.requirementIds);
  });
}

/** 从 PRD 或简报移出一条需求。PRD 的「PRD」检查项保留当时的值，之后恢复手工维护。 */
export async function unlinkDocumentRequirement(db: Db, actor: Actor, documentId: string, requirementId: string): Promise<void> {
  await withOrg(db, actor.orgId, async (tx) => {
    const doc = await loadDocument(tx, documentId, { lock: true });
    await requireProductRole(tx, actor, doc.productId, 'editor');
    const cfg = COVERAGE[doc.kind === 'brief' ? 'brief' : 'change'];
    const [r] = await tx.select().from(requirements).where(and(eq(requirements.id, requirementId), isNull(requirements.deletedAt))).for('update');
    if (!r || r[cfg.field] !== doc.id) throw new AppError('invalid', `该需求没有挂在这份${cfg.noun}上`);
    const now = new Date();
    await tx.update(requirements).set({ [cfg.field]: null, updatedAt: now }).where(eq(requirements.id, r.id));
    if (doc.kind === 'brief') await tx.update(documents).set({ updatedAt: now }).where(eq(documents.id, doc.id));
    const reqKey = displayKey(await productKeyOf(tx, r.productId), r.number);
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: doc.productId,
      type: 'requirement.updated',
      subjectType: 'requirement',
      subjectId: r.id,
      actor,
      payload: { changes: [{ field: cfg.field, old: doc.id, new: null }] },
    });
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: doc.productId,
      type: 'document.requirement_unlinked',
      subjectType: 'document',
      subjectId: doc.id,
      actor,
      payload: { requirementId: r.id, changes: [{ field: 'requirements', old: reqKey, new: null }] },
    });
  });
}
