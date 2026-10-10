import { and, eq } from 'drizzle-orm';
import { requireProductRole } from '../access/permissions';
import type { Db } from '../db/client';
import { documentAffectedNodes, structureNodes } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import { productKeyOf } from '../requirements/requirements';
import { type AffectedNodeView, affectedNodesInTx, assertChangeDocument, loadTree } from './affected';
import type { DocumentStatus } from './constants';
import { assertWritable, commitSystemRevisionTx, type DocumentRow, documentMarkdownTx, loadDocument, setDocumentStatusTx } from './documents';
import { documentDisplayKey } from './markdown';
import { ensureModuleDocumentTx, findModuleDocument } from './module-docs';
import { applyFeatureSection, featureSectionBody, hasTopHeadings, sourceSectionText } from './module-sections';

export type MergeItem = AffectedNodeView & {
  /** 模块文档中该功能点小节的当前正文（不含标题行）；模块文档不存在或没有这个小节时为空。 */
  current: string | null;
  /** 右侧预填：来源小节内容按声明顺序拼接（失效的跳过）；removed 为空字符串。 */
  prefill: string;
};
export type MergeGroup = {
  /** 功能点所在的模块；已不在模块下的功能点归入 module 为空的一组（不能应用，只能跳过）。 */
  module: { id: string; name: string; path: string } | null;
  document: { id: string; displayKey: string; version: number; status: DocumentStatus } | null;
  items: MergeItem[];
};
export type MergePlan = {
  document: { id: string; displayKey: string; title: string; status: DocumentStatus };
  /** 能否应用、跳过：产品编辑及以上，PRD 为已上线。 */
  canMerge: boolean;
  /** 能否撤销跳过：产品编辑及以上，PRD 为已上线或已合入。 */
  canReopen: boolean;
  done: number;
  total: number;
  groups: MergeGroup[];
};
export type MergeResult = { status: DocumentStatus; done: number; total: number; moduleDocument: { id: string; displayKey: string; version: number } | null };

export async function getMergePlan(db: Db, actor: Actor, documentId: string): Promise<MergePlan> {
  return withOrg(db, actor.orgId, async (tx) => {
    const doc = await loadDocument(tx, documentId);
    const role = await requireProductRole(tx, actor, doc.productId, 'viewer');
    assertChangeDocument(doc);
    const { items } = await affectedNodesInTx(tx, doc, role);
    const productKey = await productKeyOf(tx, doc.productId);
    const prdMarkdown = await documentMarkdownTx(tx, doc);
    const tree = await loadTree(tx, doc.productId);
    const groups: MergeGroup[] = [];
    const moduleMarkdown = new Map<string, string>();
    for (const item of items) {
      const moduleId = item.module?.id ?? null;
      let g = groups.find((x) => (x.module?.id ?? null) === moduleId);
      if (!g) {
        const mdoc = moduleId ? await findModuleDocument(tx, moduleId) : null;
        if (mdoc) moduleMarkdown.set(mdoc.id, await documentMarkdownTx(tx, mdoc));
        g = {
          module: item.module ? { ...item.module, path: tree.path(item.module.id) } : null,
          document: mdoc ? { id: mdoc.id, displayKey: documentDisplayKey(productKey, mdoc.number), version: mdoc.version, status: mdoc.status } : null,
          items: [],
        };
        groups.push(g);
      }
      const current = g.document ? featureSectionBody(moduleMarkdown.get(g.document.id)!, item.name) : null;
      const prefill =
        item.changeType === 'removed'
          ? ''
          : item.sourceSections
              .filter((s) => !s.stale)
              .map((s) => sourceSectionText(prdMarkdown, s.key))
              .filter((x): x is string => !!x)
              .join('\n\n');
      g.items.push({ ...item, current, prefill });
    }
    const canEdit = role !== 'viewer';
    return {
      document: { id: doc.id, displayKey: documentDisplayKey(productKey, doc.number), title: doc.title, status: doc.status },
      canMerge: canEdit && doc.status === 'launched',
      canReopen: canEdit && (doc.status === 'launched' || doc.status === 'merged'),
      done: items.filter((i) => i.mergeStatus !== 'pending').length,
      total: items.length,
      groups,
    };
  });
}

/** 锁住变更 PRD 与这条声明（锁顺序的前两步），检查产品编辑权限。 */
async function lockDeclaration(tx: Tx, actor: Actor, documentId: string, nodeId: string) {
  const doc = await loadDocument(tx, documentId, { lock: true });
  await requireProductRole(tx, actor, doc.productId, 'editor');
  assertChangeDocument(doc);
  const [row] = await tx
    .select()
    .from(documentAffectedNodes)
    .where(and(eq(documentAffectedNodes.documentId, doc.id), eq(documentAffectedNodes.nodeId, nodeId)))
    .for('update');
  if (!row) throw new AppError('not_found', '这份 PRD 没有声明这个功能点');
  return { doc, row };
}

function assertLaunched(doc: DocumentRow): void {
  if (doc.status !== 'launched') throw new AppError('invalid', '只有已上线的 PRD 可以合入');
}

async function progressOf(tx: Tx, documentId: string): Promise<{ done: number; total: number }> {
  const rows = await tx.select({ s: documentAffectedNodes.mergeStatus }).from(documentAffectedNodes).where(eq(documentAffectedNodes.documentId, documentId));
  return { done: rows.filter((r) => r.s !== 'pending').length, total: rows.length };
}

/** 应用或跳过之后：已上线的 PRD 的声明全部处理完时改为已合入。 */
async function finish(tx: Tx, actor: Actor, doc: DocumentRow): Promise<{ status: DocumentStatus; done: number; total: number }> {
  const p = await progressOf(tx, doc.id);
  if (doc.status === 'launched' && p.total > 0 && p.done === p.total) {
    await setDocumentStatusTx(tx, actor, doc, 'merged');
    return { status: 'merged', ...p };
  }
  return { status: doc.status, ...p };
}

/**
 * 应用一个功能点：锁顺序为变更 PRD → 声明 → 模块节点 → 模块文档（不存在则新建）→ 完成时覆盖的需求。baseVersion 是客户端看到的模块文档版本号
 * （文档不存在时为 null），与当前值不同返回冲突。added / modified 替换或按顺序插入该小节，removed 删除该小节；不论正文是否变化都写一版。
 */
export async function applyMerge(db: Db, actor: Actor, documentId: string, nodeId: string, input: { baseVersion: number | null; body: string }): Promise<MergeResult> {
  return withOrg(db, actor.orgId, async (tx) => {
    const { doc, row } = await lockDeclaration(tx, actor, documentId, nodeId);
    assertLaunched(doc);
    if (row.mergeStatus !== 'pending') throw new AppError('invalid', '这个功能点已处理');
    const removing = row.changeType === 'removed';
    if (!removing && hasTopHeadings(input.body)) throw new AppError('invalid', '合入内容里不能有一级或二级标题（二级标题是功能点的分节），请改为三级及以下');
    const tree = await loadTree(tx, doc.productId);
    const node = tree.byId.get(nodeId)!;
    const parent = node.parentId ? tree.byId.get(node.parentId) : undefined;
    if (!parent || parent.depth !== 2) throw new AppError('invalid', '这个功能点已不在任何模块下，无法合入，请跳过');
    await tx.select({ id: structureNodes.id }).from(structureNodes).where(eq(structureNodes.id, parent.id)).for('update');
    const existing = await findModuleDocument(tx, parent.id, { lock: true });
    if ((existing?.version ?? null) !== input.baseVersion) {
      throw new AppError('conflict', '模块文档已被其他人修改，请刷新左侧内容后重试', { version: existing?.version ?? null });
    }
    if (existing) assertWritable(existing);
    const mdoc = existing ?? (await ensureModuleDocumentTx(tx, actor, parent.id)).doc;
    const before = await documentMarkdownTx(tx, mdoc);
    const had = featureSectionBody(before, node.name) !== null;
    const next = applyFeatureSection(before, { name: node.name, body: removing ? '' : input.body, order: tree.children(parent.id).map((n) => n.name), remove: removing });
    const productKey = await productKeyOf(tx, doc.productId);
    const prdKey = documentDisplayKey(productKey, doc.number);
    const rev = await commitSystemRevisionTx(tx, actor, mdoc, next, { summary: `合入 ${prdKey}：${node.name}`, mergedFrom: doc.id });
    await tx
      .update(documentAffectedNodes)
      .set({ mergeStatus: 'applied', mergedRevisionId: rev.id, mergedBy: actor.memberId, mergedAt: new Date() })
      .where(eq(documentAffectedNodes.id, row.id));
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: doc.productId,
      type: 'document.merged',
      subjectType: 'document',
      subjectId: mdoc.id,
      actor,
      payload: {
        changeDocumentId: doc.id,
        changeDocument: prdKey,
        nodeId,
        changeType: row.changeType,
        revision: rev.number,
        changes: [{ field: 'section', old: had ? node.name : null, new: removing ? null : node.name }],
      },
    });
    const progress = await finish(tx, actor, doc);
    return { ...progress, moduleDocument: { id: mdoc.id, displayKey: documentDisplayKey(productKey, mdoc.number), version: rev.version } };
  });
}

export async function skipMerge(db: Db, actor: Actor, documentId: string, nodeId: string): Promise<MergeResult> {
  return withOrg(db, actor.orgId, async (tx) => {
    const { doc, row } = await lockDeclaration(tx, actor, documentId, nodeId);
    assertLaunched(doc);
    if (row.mergeStatus !== 'pending') throw new AppError('invalid', '这个功能点已处理');
    await tx.update(documentAffectedNodes).set({ mergeStatus: 'skipped', mergedRevisionId: null, mergedBy: actor.memberId, mergedAt: new Date() }).where(eq(documentAffectedNodes.id, row.id));
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: doc.productId,
      type: 'document.affected_node_skipped',
      subjectType: 'document',
      subjectId: doc.id,
      actor,
      payload: { nodeId, changes: [{ field: 'mergeStatus', old: 'pending', new: 'skipped' }] },
    });
    return { ...(await finish(tx, actor, doc)), moduleDocument: null };
  });
}

/** 撤销跳过：skipped → pending。PRD 已因全部处理完变为已合入时退回已上线。 */
export async function reopenMerge(db: Db, actor: Actor, documentId: string, nodeId: string): Promise<MergeResult> {
  return withOrg(db, actor.orgId, async (tx) => {
    const { doc, row } = await lockDeclaration(tx, actor, documentId, nodeId);
    if (doc.status !== 'launched' && doc.status !== 'merged') throw new AppError('invalid', '只有已上线的 PRD 可以合入');
    if (row.mergeStatus !== 'skipped') throw new AppError('invalid', '只有已跳过的功能点可以撤销');
    await tx.update(documentAffectedNodes).set({ mergeStatus: 'pending', mergedRevisionId: null, mergedBy: null, mergedAt: null }).where(eq(documentAffectedNodes.id, row.id));
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: doc.productId,
      type: 'document.affected_node_reopened',
      subjectType: 'document',
      subjectId: doc.id,
      actor,
      payload: { nodeId, changes: [{ field: 'mergeStatus', old: 'skipped', new: 'pending' }] },
    });
    if (doc.status === 'merged') await setDocumentStatusTx(tx, actor, doc, 'launched');
    const p = await progressOf(tx, doc.id);
    return { status: 'launched', ...p, moduleDocument: null };
  });
}
