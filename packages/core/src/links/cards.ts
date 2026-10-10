import { and, eq, inArray, isNull } from 'drizzle-orm';
import { productRoleOf, visibleProductIds } from '../access/permissions';
import type { Db } from '../db/client';
import { documentRevisions, documents, entityLinks, iterations, products, requirements, structureNodes, tasks } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import { DOCUMENT_STATUS_LABELS, documentDisplayKey, normalizeHeading, splitSections } from '../documents/markdown';
import type { Actor, ProductRole } from '../domain-types';
import { AppError } from '../errors';
import { ITERATION_STATUS_LABELS, stateInfoByProduct, stateOf } from '../iterations/iterations';
import { displayKey as requirementDisplayKey } from '../requirements/requirements';
import { nodePathTexts } from './links';
import { type LinkSourceType, type LinkTargetType, taskDisplayKey } from './syntax';

export type LinkCardState = 'ok' | 'missing' | 'deleted' | 'canceled' | 'section_missing' | 'hidden';
export type LinkCard = {
  /** 规范写法；页面用 canonicalWikiText 算出正文里 [[ ]] 的写法来找对应的卡。 */
  text: string;
  targetType: LinkTargetType | null;
  state: LinkCardState;
  displayKey: string;
  title: string | null;
  status: { label: string; color: string | null } | null;
  /** 组织内的相对地址（不含 /{org}/）；看不到、不存在或已删除时为空。 */
  href: string | null;
};

const TASK_STATUS_LABELS = { todo: '待开始', doing: '进行中', done: '已完成' } as const;

type LinkRow = typeof entityLinks.$inferSelect;
type Target = {
  productId: string | null;
  /** 需求、PRD、任务有编号；迭代与节点以名称为标识。 */
  numbered: boolean;
  state: 'ok' | 'deleted' | 'canceled';
  displayKey: string;
  title: string | null;
  status: LinkCard['status'];
  href: string | null;
  /** PRD 当前正文的小节标题（归一化后）。 */
  headings?: string[];
};

export const sourceKey = (type: LinkSourceType, id: string): string => `${type}:${id}`;

async function loadTargets(tx: Tx, rows: LinkRow[]): Promise<Map<string, Target>> {
  const out = new Map<string, Target>();
  const ids = (type: LinkTargetType) => [...new Set(rows.filter((r) => r.targetType === type && r.targetId).map((r) => r.targetId!))];
  const keyOf = new Map((await tx.select({ id: products.id, key: products.key }).from(products)).map((p) => [p.id, p.key]));

  const reqIds = ids('requirement');
  if (reqIds.length > 0) {
    const rs = await tx.select().from(requirements).where(inArray(requirements.id, reqIds));
    const info = await stateInfoByProduct(tx, rs.map((r) => r.productId));
    for (const r of rs) {
      const st = stateOf(info, r.productId, r.stateKey);
      const key = requirementDisplayKey(keyOf.get(r.productId)!, r.number);
      out.set(`requirement:${r.id}`, {
        productId: r.productId,
        numbered: true,
        state: r.deletedAt ? 'deleted' : st.category === 'canceled' ? 'canceled' : 'ok',
        displayKey: key,
        title: r.title,
        status: { label: st.label, color: st.color },
        href: r.deletedAt ? null : `requirements/${key}`,
      });
    }
  }

  const docIds = ids('document');
  if (docIds.length > 0) {
    const ds = await tx.select().from(documents).where(inArray(documents.id, docIds));
    const revIds = ds.map((d) => d.currentRevisionId).filter((x): x is string => !!x);
    const revs = revIds.length > 0 ? await tx.select({ id: documentRevisions.id, snapshot: documentRevisions.snapshot }).from(documentRevisions).where(inArray(documentRevisions.id, revIds)) : [];
    const headingsOf = new Map(revs.map((v) => [v.id, splitSections(v.snapshot.markdown).flatMap((s) => (s.heading ? [normalizeHeading(s.heading)] : []))]));
    for (const d of ds) {
      const key = documentDisplayKey(keyOf.get(d.productId)!, d.number);
      out.set(`document:${d.id}`, {
        productId: d.productId,
        numbered: true,
        state: d.deletedAt ? 'deleted' : d.status === 'discarded' ? 'canceled' : 'ok',
        displayKey: key,
        title: d.title,
        status: { label: DOCUMENT_STATUS_LABELS[d.status], color: null },
        href: d.deletedAt ? null : `documents/${key}`,
        headings: d.currentRevisionId ? (headingsOf.get(d.currentRevisionId) ?? []) : [],
      });
    }
  }

  const taskIds = ids('task');
  if (taskIds.length > 0) {
    for (const x of await tx.select().from(tasks).where(inArray(tasks.id, taskIds))) {
      const key = taskDisplayKey(keyOf.get(x.productId)!, x.number);
      out.set(`task:${x.id}`, { productId: x.productId, numbered: true, state: 'ok', displayKey: key, title: x.title, status: { label: TASK_STATUS_LABELS[x.status], color: null }, href: `tasks/${key}` });
    }
  }

  const iterIds = ids('iteration');
  if (iterIds.length > 0) {
    for (const i of await tx.select().from(iterations).where(inArray(iterations.id, iterIds))) {
      out.set(`iteration:${i.id}`, {
        productId: i.productId,
        numbered: false,
        state: i.deletedAt ? 'deleted' : i.status === 'canceled' ? 'canceled' : 'ok',
        displayKey: `迭代:${i.name}`,
        title: null,
        status: { label: ITERATION_STATUS_LABELS[i.status], color: null },
        href: i.deletedAt ? null : `iterations/${i.id}`,
      });
    }
  }

  const nodeIds = ids('structure_node');
  if (nodeIds.length > 0) {
    const ns = await tx.select().from(structureNodes).where(inArray(structureNodes.id, nodeIds));
    // 模块与功能点链接到模块文档：模块为自己，功能点为父模块；业务域仍链接到需求列表
    const moduleOf = (n: { id: string; depth: number; parentId: string | null }): string | null => (n.depth === 2 ? n.id : n.depth === 3 ? n.parentId : null);
    const moduleIds = [...new Set(ns.map(moduleOf).filter((x): x is string => !!x))];
    const moduleDocs =
      moduleIds.length > 0
        ? await tx
            .select({ nodeId: documents.nodeId, number: documents.number })
            .from(documents)
            .where(and(inArray(documents.nodeId, moduleIds), eq(documents.kind, 'module'), isNull(documents.deletedAt)))
        : [];
    const docNumberOf = new Map(moduleDocs.map((d) => [d.nodeId!, d.number]));
    for (const pid of new Set(ns.map((n) => n.productId))) {
      const paths = await nodePathTexts(tx, pid);
      const key = keyOf.get(pid)!;
      for (const n of ns.filter((x) => x.productId === pid)) {
        const moduleId = moduleOf(n);
        const number = moduleId ? docNumberOf.get(moduleId) : undefined;
        const href = !moduleId
          ? `requirements?product=${key}&node=${n.id}`
          : number === undefined
            ? `documents?product=${key}&view=modules&node=${moduleId}`
            : `documents/${documentDisplayKey(key, number)}${n.depth === 3 ? `?section=${encodeURIComponent(n.name)}` : ''}`;
        out.set(`structure_node:${n.id}`, {
          productId: pid,
          numbered: false,
          state: n.status === 'deprecated' ? 'canceled' : 'ok',
          displayKey: paths.get(n.id)!.slice(key.length + 1),
          title: null,
          status: n.status === 'deprecated' ? { label: '已停用', color: null } : null,
          href,
        });
      }
    }
  }
  return out;
}

function toCard(row: LinkRow, t: Target | undefined, visible: boolean): LinkCard {
  const base = { text: row.targetText, targetType: row.targetType };
  const blank = { title: null, status: null, href: null };
  if (!row.targetId) return { ...base, state: 'missing', displayKey: row.targetText, ...blank };
  if (!t) return { ...base, state: 'deleted', displayKey: row.targetText, ...blank };
  if (!visible) return { ...base, state: 'hidden', displayKey: t.numbered ? t.displayKey : row.targetText, ...blank };
  const section = row.targetSection;
  const displayKey = section ? `${t.displayKey}#${section}` : t.displayKey;
  if (section && t.state === 'ok' && !(t.headings ?? []).includes(normalizeHeading(section))) {
    return { ...base, state: 'section_missing', displayKey, title: t.title, status: t.status, href: t.href };
  }
  return { ...base, state: t.state, displayKey, title: t.title, status: t.status, href: t.href && section ? `${t.href}?section=${encodeURIComponent(section)}` : t.href };
}

/** 一批来源的链接卡，按来源分组（键为 sourceKey），同一来源按规范写法去重。按查看者的产品权限决定能看到多少。 */
export async function linkCardsFor(tx: Tx, actor: Actor, sources: Array<{ type: LinkSourceType; id: string }>): Promise<Map<string, LinkCard[]>> {
  const out = new Map<string, LinkCard[]>(sources.map((s) => [sourceKey(s.type, s.id), []]));
  const rows: LinkRow[] = [];
  for (const type of new Set(sources.map((s) => s.type))) {
    const ids = sources.filter((s) => s.type === type).map((s) => s.id);
    rows.push(
      ...(await tx
        .select()
        .from(entityLinks)
        .where(and(eq(entityLinks.sourceType, type), inArray(entityLinks.sourceId, ids), eq(entityLinks.origin, 'wikilink')))),
    );
  }
  if (rows.length === 0) return out;
  const targets = await loadTargets(tx, rows);
  const roles = new Map<string, ProductRole | null>();
  let anyVisible: boolean | null = null;
  const canSee = async (t: Target): Promise<boolean> => {
    if (t.productId === null) {
      // 专项不属于产品：能看到任一产品的人都能看到（与迭代列表一致）
      anyVisible ??= (await visibleProductIds(tx, actor)).size > 0;
      return anyVisible;
    }
    if (!roles.has(t.productId)) roles.set(t.productId, await productRoleOf(tx, actor, t.productId));
    return roles.get(t.productId) !== null;
  };
  for (const row of rows) {
    const list = out.get(sourceKey(row.sourceType, row.sourceId))!;
    if (list.some((c) => c.text === row.targetText)) continue;
    const t = row.targetId ? targets.get(`${row.targetType}:${row.targetId}`) : undefined;
    list.push(toCard(row, t, t ? await canSee(t) : false));
  }
  return out;
}

/** PRD 正文的链接卡：与 PRD 详情分开读取，编辑器保存后单独刷新，不动详情里的正文缓存。 */
export async function listDocumentLinkCards(db: Db, actor: Actor, documentId: string): Promise<LinkCard[]> {
  return withOrg(db, actor.orgId, async (tx) => {
    const [d] = await tx.select({ productId: documents.productId }).from(documents).where(and(eq(documents.id, documentId), isNull(documents.deletedAt)));
    if (!d || !(await productRoleOf(tx, actor, d.productId))) throw new AppError('not_found', 'PRD 不存在');
    return (await linkCardsFor(tx, actor, [{ type: 'document', id: documentId }])).get(sourceKey('document', documentId))!;
  });
}
