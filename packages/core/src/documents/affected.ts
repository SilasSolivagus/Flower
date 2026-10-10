import { and, eq, inArray } from 'drizzle-orm';
import { requireProductRole } from '../access/permissions';
import type { Db } from '../db/client';
import { documentAffectedNodes, documentRevisions, structureNodes } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor, ProductRole } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import { memberNames } from '../requirements/context';
import type { StructureNodeView } from '../requirements/lookups';
import type { MemberRef } from '../requirements/requirements';
import { insertStructureNodeTx } from '../structure/nodes';
import { AFFECTED_CHANGE_TYPES, type AffectedChangeType, type DocumentStatus, type MergeStatus } from './constants';
import { type DocumentRow, documentMarkdownTx, loadDocument } from './documents';
import { DOCUMENT_STATUS_LABELS } from './markdown';
import { prdSectionKeys } from './module-sections';

export const MAX_SOURCE_SECTIONS = 20;
/** 可以修改影响声明的 PRD 状态。 */
const DECLARABLE: DocumentStatus[] = ['draft', 'review', 'approved', 'launched'];

type NodeRow = typeof structureNodes.$inferSelect;

export type AffectedNodeView = {
  nodeId: string;
  name: string;
  /** 业务域/模块/功能点。 */
  path: string;
  /** 功能点所在的模块（父节点为第二层时）；已不在模块下时为空。 */
  module: { id: string; name: string } | null;
  nodeStatus: 'active' | 'deprecated';
  changeType: AffectedChangeType;
  /** 按声明顺序；stale 为 PRD 当前正文里已没有这个小节。 */
  sourceSections: Array<{ key: string; stale: boolean }>;
  mergeStatus: MergeStatus;
  mergedRevisionNumber: number | null;
  mergedBy: MemberRef | null;
  mergedAt: Date | null;
};
export type AffectedNodes = {
  /** 当前查看者能否增删改声明。 */
  editable: boolean;
  /** 已有声明被应用或跳过：声明只能在合入页处理。 */
  locked: boolean;
  /** PRD 当前正文可选的来源小节（splitSections 的键，只含有标题的小节）；外部 PRD 为空。 */
  sections: string[];
  items: AffectedNodeView[];
};

export type StructureTree = {
  byId: Map<string, NodeRow>;
  /** 先序位置：同级按 sort，再按名称。 */
  rank: Map<string, number>;
  path: (id: string) => string;
  children: (parentId: string) => NodeRow[];
};

const byTreeOrder = (a: NodeRow, b: NodeRow): number => a.sort - b.sort || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** 产品的结构树：节点、先序位置、名称路径、按顺序的子节点。 */
export async function loadTree(tx: Tx, productId: string): Promise<StructureTree> {
  const rows = await tx.select().from(structureNodes).where(eq(structureNodes.productId, productId));
  const byId = new Map(rows.map((n) => [n.id, n]));
  const kids = new Map<string | null, NodeRow[]>();
  for (const n of rows) kids.set(n.parentId, [...(kids.get(n.parentId) ?? []), n]);
  for (const list of kids.values()) list.sort(byTreeOrder);
  const rank = new Map<string, number>();
  const visit = (parentId: string | null) => {
    for (const n of kids.get(parentId) ?? []) {
      rank.set(n.id, rank.size);
      visit(n.id);
    }
  };
  visit(null);
  const path = (id: string): string => {
    const names: string[] = [];
    for (let cur = byId.get(id); cur; cur = cur.parentId ? byId.get(cur.parentId) : undefined) names.unshift(cur.name);
    return names.join('/');
  };
  return { byId, rank, path, children: (parentId) => kids.get(parentId) ?? [] };
}

export function assertChangeDocument(doc: DocumentRow): void {
  if (doc.kind !== 'change') throw new AppError('invalid', '模块文档没有影响声明');
}

function assertChangeType(v: string): void {
  if (!(AFFECTED_CHANGE_TYPES as readonly string[]).includes(v)) throw new AppError('invalid', '变更类型无效');
}

const rowsOf = (tx: Tx, documentId: string) => tx.select().from(documentAffectedNodes).where(eq(documentAffectedNodes.documentId, documentId));

/** 声明能否修改：变更 PRD 处于草稿到已上线之间，且还没有任何一条被应用或跳过。 */
export async function assertDeclarationsEditable(tx: Tx, doc: DocumentRow): Promise<void> {
  assertChangeDocument(doc);
  if (!DECLARABLE.includes(doc.status)) throw new AppError('invalid', `「${DOCUMENT_STATUS_LABELS[doc.status]}」的 PRD 不能修改影响声明`);
  if ((await rowsOf(tx, doc.id)).some((r) => r.mergeStatus !== 'pending')) throw new AppError('invalid', '已开始合入，影响声明不能再修改');
}

/** 来源小节：去空白、去重（保留顺序）；必须是 PRD 当前正文里的小节，或这条声明原来就有的（已失效的可以保留）。 */
function cleanSources(doc: DocumentRow, markdown: string, keys: string[] | undefined, kept: string[] = []): string[] {
  const list = [...new Set((keys ?? []).map((k) => k.trim()).filter(Boolean))];
  if (list.length === 0) return [];
  if (doc.source !== 'native') throw new AppError('invalid', '外部 PRD 没有正文，不能选择来源小节');
  if (list.length > MAX_SOURCE_SECTIONS) throw new AppError('invalid', `来源小节最多 ${MAX_SOURCE_SECTIONS} 个`);
  const valid = new Set([...prdSectionKeys(markdown), ...kept]);
  const bad = list.filter((k) => !valid.has(k));
  if (bad.length > 0) throw new AppError('invalid', `PRD 中没有这些小节：${bad.join('、')}`);
  return list;
}

const declared = (path: string, r: { changeType: AffectedChangeType; sourceSections: string[] }) => ({ path, changeType: r.changeType, sourceSections: r.sourceSections });

export async function affectedNodesInTx(tx: Tx, doc: DocumentRow, role: ProductRole): Promise<AffectedNodes> {
  const rows = await rowsOf(tx, doc.id);
  const tree = await loadTree(tx, doc.productId);
  const sections = doc.source === 'native' ? prdSectionKeys(await documentMarkdownTx(tx, doc)) : [];
  const current = new Set(sections);
  const revIds = rows.map((r) => r.mergedRevisionId).filter((x): x is string => !!x);
  const revs = revIds.length > 0 ? await tx.select({ id: documentRevisions.id, version: documentRevisions.version }).from(documentRevisions).where(inArray(documentRevisions.id, revIds)) : [];
  const revNumber = new Map(revs.map((r) => [r.id, r.version]));
  const names = await memberNames(tx, rows.map((r) => r.mergedBy));
  const locked = rows.some((r) => r.mergeStatus !== 'pending');
  const items = rows
    .map((r): AffectedNodeView => {
      const node = tree.byId.get(r.nodeId)!;
      const parent = node.parentId ? tree.byId.get(node.parentId) : undefined;
      return {
        nodeId: r.nodeId,
        name: node.name,
        path: tree.path(r.nodeId),
        module: parent && parent.depth === 2 ? { id: parent.id, name: parent.name } : null,
        nodeStatus: node.status,
        changeType: r.changeType,
        sourceSections: r.sourceSections.map((key) => ({ key, stale: !current.has(key) })),
        mergeStatus: r.mergeStatus,
        mergedRevisionNumber: r.mergedRevisionId ? (revNumber.get(r.mergedRevisionId) ?? null) : null,
        mergedBy: r.mergedBy ? { id: r.mergedBy, displayName: names.get(r.mergedBy) ?? '已删除的成员' } : null,
        mergedAt: r.mergedAt,
      };
    })
    .sort((a, b) => (tree.rank.get(a.nodeId) ?? 0) - (tree.rank.get(b.nodeId) ?? 0));
  return { editable: role !== 'viewer' && DECLARABLE.includes(doc.status) && !locked, locked, sections, items };
}

export async function listAffectedNodes(db: Db, actor: Actor, documentId: string): Promise<AffectedNodes> {
  return withOrg(db, actor.orgId, async (tx) => {
    const doc = await loadDocument(tx, documentId);
    const role = await requireProductRole(tx, actor, doc.productId, 'viewer');
    assertChangeDocument(doc);
    return affectedNodesInTx(tx, doc, role);
  });
}

export async function addAffectedNode(
  db: Db,
  actor: Actor,
  documentId: string,
  input: { nodeId: string; changeType: AffectedChangeType; sourceSections?: string[] },
): Promise<AffectedNodes> {
  assertChangeType(input.changeType);
  return withOrg(db, actor.orgId, async (tx) => {
    const doc = await loadDocument(tx, documentId, { lock: true });
    const role = await requireProductRole(tx, actor, doc.productId, 'editor');
    await assertDeclarationsEditable(tx, doc);
    const [node] = await tx.select().from(structureNodes).where(eq(structureNodes.id, input.nodeId));
    if (!node || node.productId !== doc.productId || node.depth !== 3) throw new AppError('invalid', '只能声明本产品结构树第三层的功能点');
    const [dup] = await tx
      .select({ id: documentAffectedNodes.id })
      .from(documentAffectedNodes)
      .where(and(eq(documentAffectedNodes.documentId, doc.id), eq(documentAffectedNodes.nodeId, node.id)));
    if (dup) throw new AppError('conflict', '该功能点已声明');
    const sourceSections = cleanSources(doc, await documentMarkdownTx(tx, doc), input.sourceSections);
    await tx.insert(documentAffectedNodes).values({ orgId: actor.orgId, documentId: doc.id, nodeId: node.id, changeType: input.changeType, sourceSections });
    const tree = await loadTree(tx, doc.productId);
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: doc.productId,
      type: 'document.affected_nodes_changed',
      subjectType: 'document',
      subjectId: doc.id,
      actor,
      payload: { nodeId: node.id, changes: [{ field: 'affectedNode', old: null, new: declared(tree.path(node.id), { changeType: input.changeType, sourceSections }) }] },
    });
    return affectedNodesInTx(tx, doc, role);
  });
}

async function loadDeclaration(tx: Tx, documentId: string, nodeId: string) {
  const [row] = await tx
    .select()
    .from(documentAffectedNodes)
    .where(and(eq(documentAffectedNodes.documentId, documentId), eq(documentAffectedNodes.nodeId, nodeId)));
  if (!row) throw new AppError('not_found', '这份 PRD 没有声明这个功能点');
  return row;
}

export async function updateAffectedNode(
  db: Db,
  actor: Actor,
  documentId: string,
  nodeId: string,
  input: { changeType?: AffectedChangeType; sourceSections?: string[] },
): Promise<AffectedNodes> {
  if (input.changeType !== undefined) assertChangeType(input.changeType);
  return withOrg(db, actor.orgId, async (tx) => {
    const doc = await loadDocument(tx, documentId, { lock: true });
    const role = await requireProductRole(tx, actor, doc.productId, 'editor');
    await assertDeclarationsEditable(tx, doc);
    const row = await loadDeclaration(tx, doc.id, nodeId);
    const next = {
      changeType: input.changeType ?? row.changeType,
      sourceSections: input.sourceSections === undefined ? row.sourceSections : cleanSources(doc, await documentMarkdownTx(tx, doc), input.sourceSections, row.sourceSections),
    };
    const changes = [
      ...(next.changeType === row.changeType ? [] : [{ field: 'changeType', old: row.changeType, new: next.changeType }]),
      ...(JSON.stringify(next.sourceSections) === JSON.stringify(row.sourceSections) ? [] : [{ field: 'sourceSections', old: row.sourceSections, new: next.sourceSections }]),
    ];
    if (changes.length > 0) {
      await tx.update(documentAffectedNodes).set(next).where(eq(documentAffectedNodes.id, row.id));
      const tree = await loadTree(tx, doc.productId);
      await recordEvent(tx, {
        orgId: actor.orgId,
        productId: doc.productId,
        type: 'document.affected_nodes_changed',
        subjectType: 'document',
        subjectId: doc.id,
        actor,
        payload: { nodeId, path: tree.path(nodeId), changes },
      });
    }
    return affectedNodesInTx(tx, doc, role);
  });
}

export async function removeAffectedNode(db: Db, actor: Actor, documentId: string, nodeId: string): Promise<AffectedNodes> {
  return withOrg(db, actor.orgId, async (tx) => {
    const doc = await loadDocument(tx, documentId, { lock: true });
    const role = await requireProductRole(tx, actor, doc.productId, 'editor');
    await assertDeclarationsEditable(tx, doc);
    const row = await loadDeclaration(tx, doc.id, nodeId);
    await tx.delete(documentAffectedNodes).where(eq(documentAffectedNodes.id, row.id));
    const tree = await loadTree(tx, doc.productId);
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: doc.productId,
      type: 'document.affected_nodes_changed',
      subjectType: 'document',
      subjectId: doc.id,
      actor,
      payload: { nodeId, changes: [{ field: 'affectedNode', old: declared(tree.path(nodeId), row), new: null }] },
    });
    return affectedNodesInTx(tx, doc, role);
  });
}

/**
 * 声明影响时当场新建：parentId 为业务域时新建模块，为模块时新建功能点。声明可以修改时产品编辑及以上可用
 * （结构树页签的新建仍要求产品管理员）；同名检查、事件与接上悬空链接沿用结构树服务。
 */
export async function createNodeForDocument(db: Db, actor: Actor, documentId: string, input: { parentId: string; name: string }): Promise<StructureNodeView> {
  return withOrg(db, actor.orgId, async (tx) => {
    const doc = await loadDocument(tx, documentId, { lock: true });
    await requireProductRole(tx, actor, doc.productId, 'editor');
    await assertDeclarationsEditable(tx, doc);
    const [parent] = await tx.select().from(structureNodes).where(eq(structureNodes.id, input.parentId));
    if (!parent || parent.productId !== doc.productId) throw new AppError('invalid', '上级节点不属于该产品');
    if (parent.depth > 2) throw new AppError('invalid', '只能在业务域下新建模块，或在模块下新建功能点');
    return insertStructureNodeTx(tx, actor, doc.productId, { parentId: parent.id, name: input.name });
  });
}
