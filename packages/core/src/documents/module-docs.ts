import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { requireProductRole } from '../access/permissions';
import type { Db } from '../db/client';
import { documentRevisions, documents, products, structureNodes } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import { relinkDangling } from '../links/links';
import { productKeyOf } from '../requirements/requirements';
import type { DocumentStatus } from './constants';
import { type DocumentDetail, documentDetailInTx, type DocumentRow, writeRevision } from './documents';
import { documentDisplayKey } from './markdown';

export type ModuleDocumentRow = {
  node: { id: string; name: string; status: 'active' | 'deprecated' };
  featureCount: number;
  document: { id: string; displayKey: string; title: string; status: DocumentStatus; updatedAt: Date } | null;
  /** 最近一次合入（带合入来源的修订）的时间。 */
  lastMergedAt: Date | null;
};
export type ModuleDocumentGroup = { domain: { id: string; name: string; status: 'active' | 'deprecated' }; modules: ModuleDocumentRow[] };
export type ModuleDocumentTree = { productKey: string; groups: ModuleDocumentGroup[] };

/** 模块节点（结构树第二层）未删除的模块文档，没有时为 null。lock 时锁住文档行。 */
export async function findModuleDocument(tx: Tx, moduleId: string, opts: { lock?: boolean } = {}): Promise<DocumentRow | null> {
  const q = tx
    .select()
    .from(documents)
    .where(and(eq(documents.nodeId, moduleId), eq(documents.kind, 'module'), isNull(documents.deletedAt)));
  const [d] = opts.lock ? await q.for('update') : await q;
  return d ?? null;
}

/**
 * 取模块节点的模块文档，没有时新建（标题为模块名称，概述为空，第 1 版）。先锁模块节点行再查再建，
 * 同一模块的并发新建排队进行。调用方已检查权限。
 */
export async function ensureModuleDocumentTx(tx: Tx, actor: Actor, moduleId: string): Promise<{ doc: DocumentRow; created: boolean }> {
  const [node] = await tx.select().from(structureNodes).where(eq(structureNodes.id, moduleId)).for('update');
  if (!node || node.depth !== 2) throw new AppError('invalid', '只有模块节点可以有模块文档');
  const existing = await findModuleDocument(tx, moduleId, { lock: true });
  if (existing) return { doc: existing, created: false };
  const [seq] = await tx
    .update(products)
    .set({ documentSeq: sql`${products.documentSeq} + 1` })
    .where(eq(products.id, node.productId))
    .returning({ n: products.documentSeq, key: products.key });
  const [row] = await tx
    .insert(documents)
    .values({ orgId: actor.orgId, productId: node.productId, number: seq!.n, kind: 'module', source: 'native', title: node.name, nodeId: node.id, status: 'active', createdBy: actor.memberId })
    .returning();
  const rev = await writeRevision(tx, actor, row!, { title: node.name, markdown: '' }, { summary: null, allowMerge: false });
  await tx.update(documents).set({ currentRevisionId: rev.id }).where(eq(documents.id, row!.id));
  await recordEvent(tx, {
    orgId: actor.orgId,
    productId: node.productId,
    type: 'document.created',
    subjectType: 'document',
    subjectId: row!.id,
    actor,
    payload: { number: row!.number, title: node.name, kind: 'module', nodeId: node.id },
  });
  await relinkDangling(tx, { type: 'document', id: row!.id, texts: [documentDisplayKey(seq!.key, row!.number)], withSections: true });
  return { doc: { ...row!, currentRevisionId: rev.id }, created: true };
}

/** 打开模块的模块文档，没有时新建。产品编辑及以上；重复调用返回同一份。 */
export async function createModuleDocument(db: Db, actor: Actor, nodeId: string): Promise<DocumentDetail> {
  return withOrg(db, actor.orgId, async (tx) => {
    const [node] = await tx.select({ productId: structureNodes.productId }).from(structureNodes).where(eq(structureNodes.id, nodeId));
    if (!node) throw new AppError('not_found', '节点不存在');
    await requireProductRole(tx, actor, node.productId, 'editor');
    const { doc } = await ensureModuleDocumentTx(tx, actor, nodeId);
    return documentDetailInTx(tx, actor, doc.id);
  });
}

/** 「模块文档」页签：按业务域 → 模块列出（同级按 sort、名称），是否已有文档、功能点数、最近合入时间。 */
export async function listModuleDocuments(db: Db, actor: Actor, productId: string): Promise<ModuleDocumentTree> {
  return withOrg(db, actor.orgId, async (tx) => {
    await requireProductRole(tx, actor, productId, 'viewer');
    const productKey = await productKeyOf(tx, productId);
    const nodes = await tx.select().from(structureNodes).where(eq(structureNodes.productId, productId)).orderBy(asc(structureNodes.sort), asc(structureNodes.name));
    const docs = await tx
      .select()
      .from(documents)
      .where(and(eq(documents.productId, productId), eq(documents.kind, 'module'), isNull(documents.deletedAt)));
    const merged =
      docs.length > 0
        ? await tx
            .select({ id: documentRevisions.documentId, at: sql<Date>`max(${documentRevisions.createdAt})`.mapWith(documentRevisions.createdAt) })
            .from(documentRevisions)
            .where(and(inArray(documentRevisions.documentId, docs.map((d) => d.id)), isNotNull(documentRevisions.mergedFromDocumentId)))
            .groupBy(documentRevisions.documentId)
        : [];
    const docOf = new Map(docs.map((d) => [d.nodeId!, d]));
    const mergedAt = new Map(merged.map((m) => [m.id, m.at]));
    const groups = nodes
      .filter((n) => n.depth === 1)
      .map((domain) => ({
        domain: { id: domain.id, name: domain.name, status: domain.status },
        modules: nodes
          .filter((m) => m.depth === 2 && m.parentId === domain.id)
          .map((m) => {
            const d = docOf.get(m.id);
            return {
              node: { id: m.id, name: m.name, status: m.status },
              featureCount: nodes.filter((f) => f.depth === 3 && f.parentId === m.id).length,
              document: d ? { id: d.id, displayKey: documentDisplayKey(productKey, d.number), title: d.title, status: d.status, updatedAt: d.updatedAt } : null,
              lastMergedAt: d ? (mergedAt.get(d.id) ?? null) : null,
            };
          }),
      }));
    return { productKey, groups };
  });
}
