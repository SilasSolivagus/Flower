import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { requireProductRole } from '../access/permissions';
import type { Db } from '../db/client';
import { structureNodes } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError, isUniqueViolation } from '../errors';
import { recordEvent } from '../events';
import { relinkNodes } from '../links/links';
import type { StructureNodeView } from '../requirements/lookups';

export const MAX_STRUCTURE_DEPTH = 3;

type NodeRow = typeof structureNodes.$inferSelect;

const view = (n: NodeRow): StructureNodeView => ({
  id: n.id,
  parentId: n.parentId,
  depth: n.depth,
  name: n.name,
  description: n.description,
  status: n.status,
  sort: n.sort,
});

function assertName(name: string): string {
  const n = name.trim();
  if (!n || n.length > 50) throw new AppError('invalid', '节点名称不能为空，且不超过 50 个字符');
  return n;
}

function assertDescription(d: string | null | undefined): string | null {
  const v = d?.trim() || null;
  if (v && v.length > 2000) throw new AppError('invalid', '节点说明不超过 2000 个字符');
  return v;
}

function duplicateName(e: unknown): never {
  if (isUniqueViolation(e)) throw new AppError('conflict', '同一上级下已有同名节点');
  throw e;
}

const siblingsOf = (productId: string, parentId: string | null) =>
  and(eq(structureNodes.productId, productId), parentId === null ? isNull(structureNodes.parentId) : eq(structureNodes.parentId, parentId));

async function loadNode(tx: Tx, id: string): Promise<NodeRow> {
  const [n] = await tx.select().from(structureNodes).where(eq(structureNodes.id, id));
  if (!n) throw new AppError('not_found', '节点不存在');
  return n;
}

async function nextSort(tx: Tx, productId: string, parentId: string | null): Promise<number> {
  const [row] = await tx.select({ max: sql<number | null>`max(${structureNodes.sort})` }).from(structureNodes).where(siblingsOf(productId, parentId));
  return (row?.max ?? -1) + 1;
}

function subtreeIds(all: Array<{ id: string; parentId: string | null }>, rootId: string): Set<string> {
  const out = new Set([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of all) {
      if (n.parentId && out.has(n.parentId) && !out.has(n.id)) {
        out.add(n.id);
        grew = true;
      }
    }
  }
  return out;
}

export async function createStructureNode(
  db: Db,
  actor: Actor,
  productId: string,
  input: { parentId?: string | null; name: string; description?: string | null },
): Promise<StructureNodeView> {
  const name = assertName(input.name);
  const description = assertDescription(input.description);
  return withOrg(db, actor.orgId, async (tx) => {
    await requireProductRole(tx, actor, productId, 'admin');
    const parentId = input.parentId ?? null;
    let depth = 1;
    if (parentId) {
      const parent = await loadNode(tx, parentId);
      if (parent.productId !== productId) throw new AppError('invalid', '上级节点不属于该产品');
      if (parent.status === 'deprecated') throw new AppError('invalid', '不能在已停用的节点下新增');
      depth = parent.depth + 1;
      if (depth > MAX_STRUCTURE_DEPTH) throw new AppError('invalid', `结构树最多 ${MAX_STRUCTURE_DEPTH} 层`);
    }
    const sort = await nextSort(tx, productId, parentId);
    let row: NodeRow;
    try {
      [row] = (await tx.insert(structureNodes).values({ orgId: actor.orgId, productId, parentId, depth, name, description, sort }).returning()) as [NodeRow];
    } catch (e) {
      duplicateName(e);
    }
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId,
      type: 'structure_node.created',
      subjectType: 'structure_node',
      subjectId: row.id,
      actor,
      payload: { name, parentId, depth },
    });
    await relinkNodes(tx, productId, [row.id]);
    return view(row);
  });
}

export async function updateStructureNode(
  db: Db,
  actor: Actor,
  nodeId: string,
  input: { name?: string; description?: string | null; status?: 'active' | 'deprecated' },
): Promise<StructureNodeView> {
  if (input.status !== undefined && input.status !== 'active' && input.status !== 'deprecated') throw new AppError('invalid', '节点状态无效');
  return withOrg(db, actor.orgId, async (tx) => {
    const cur = await loadNode(tx, nodeId);
    await requireProductRole(tx, actor, cur.productId, 'admin');
    const next = {
      name: input.name === undefined ? cur.name : assertName(input.name),
      description: input.description === undefined ? cur.description : assertDescription(input.description),
      status: input.status ?? cur.status,
    };
    const changes = (Object.keys(next) as Array<keyof typeof next>)
      .map((field) => ({ field, old: cur[field], new: next[field] }))
      .filter((c) => c.old !== c.new);
    let row: NodeRow;
    try {
      [row] = (await tx.update(structureNodes).set(next).where(eq(structureNodes.id, nodeId)).returning()) as [NodeRow];
    } catch (e) {
      duplicateName(e);
    }
    if (changes.length > 0) {
      await recordEvent(tx, { orgId: actor.orgId, productId: cur.productId, type: 'structure_node.updated', subjectType: 'structure_node', subjectId: nodeId, actor, payload: { changes } });
    }
    if (next.name !== cur.name) {
      const all = await tx.select({ id: structureNodes.id, parentId: structureNodes.parentId }).from(structureNodes).where(eq(structureNodes.productId, cur.productId));
      await relinkNodes(tx, cur.productId, subtreeIds(all, nodeId));
    }
    return view(row);
  });
}

export async function moveStructureNode(db: Db, actor: Actor, nodeId: string, input: { parentId: string | null }): Promise<StructureNodeView> {
  return withOrg(db, actor.orgId, async (tx) => {
    const node = await loadNode(tx, nodeId);
    await requireProductRole(tx, actor, node.productId, 'admin');
    if (input.parentId === node.parentId) return view(node);
    const all = await tx
      .select({ id: structureNodes.id, parentId: structureNodes.parentId, depth: structureNodes.depth, status: structureNodes.status })
      .from(structureNodes)
      .where(eq(structureNodes.productId, node.productId));
    const subtree = subtreeIds(all, node.id);
    let depth = 1;
    if (input.parentId) {
      const parent = all.find((n) => n.id === input.parentId);
      if (!parent) throw new AppError('invalid', '上级节点不属于该产品');
      if (subtree.has(parent.id)) throw new AppError('invalid', '不能移动到自身或下级节点之下');
      if (parent.status === 'deprecated') throw new AppError('invalid', '不能移动到已停用的节点下');
      depth = parent.depth + 1;
    }
    const delta = depth - node.depth;
    const deepest = Math.max(...all.filter((n) => subtree.has(n.id)).map((n) => n.depth)) + delta;
    if (deepest > MAX_STRUCTURE_DEPTH) throw new AppError('invalid', '移动后层级超过 3 层');
    const sort = await nextSort(tx, node.productId, input.parentId);
    let row: NodeRow;
    try {
      [row] = (await tx.update(structureNodes).set({ parentId: input.parentId, depth, sort }).where(eq(structureNodes.id, nodeId)).returning()) as [NodeRow];
    } catch (e) {
      duplicateName(e);
    }
    const descendants = [...subtree].filter((id) => id !== node.id);
    if (delta !== 0 && descendants.length > 0) {
      await tx
        .update(structureNodes)
        .set({ depth: sql`${structureNodes.depth} + ${delta}` })
        .where(inArray(structureNodes.id, descendants));
    }
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: node.productId,
      type: 'structure_node.moved',
      subjectType: 'structure_node',
      subjectId: nodeId,
      actor,
      payload: { changes: [{ field: 'parentId', old: node.parentId, new: input.parentId }, { field: 'depth', old: node.depth, new: depth }] },
    });
    await relinkNodes(tx, node.productId, subtree);
    return view(row);
  });
}

export async function reorderStructureNodes(
  db: Db,
  actor: Actor,
  productId: string,
  input: { parentId: string | null; nodeIds: string[] },
): Promise<StructureNodeView[]> {
  return withOrg(db, actor.orgId, async (tx) => {
    await requireProductRole(tx, actor, productId, 'admin');
    const siblings = await tx.select({ id: structureNodes.id, sort: structureNodes.sort }).from(structureNodes).where(siblingsOf(productId, input.parentId));
    const same = siblings.length === input.nodeIds.length && new Set(input.nodeIds).size === input.nodeIds.length && siblings.every((s) => input.nodeIds.includes(s.id));
    if (!same) throw new AppError('invalid', '排序必须包含同一上级下的全部节点');
    const oldSortById = new Map(siblings.map((s) => [s.id, s.sort]));
    const changes = input.nodeIds
      .map((id, i) => ({ nodeId: id, field: 'sort' as const, old: oldSortById.get(id)!, new: i }))
      .filter((c) => c.old !== c.new);
    for (const [i, id] of input.nodeIds.entries()) {
      await tx.update(structureNodes).set({ sort: i }).where(eq(structureNodes.id, id));
    }
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId,
      type: 'structure_node.reordered',
      subjectType: 'product',
      subjectId: productId,
      actor,
      payload: { parentId: input.parentId, nodeIds: input.nodeIds, changes },
    });
    const rows = await tx.select().from(structureNodes).where(siblingsOf(productId, input.parentId)).orderBy(asc(structureNodes.sort));
    return rows.map(view);
  });
}
