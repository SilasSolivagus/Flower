import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { requireProductRole, visibleProductIds } from '../access/permissions';
import type { Db } from '../db/client';
import { documentRevisions, documents, iterations, products, requirements, structureNodes, tasks } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import { documentDisplayKey, normalizeHeading, splitSections } from '../documents/markdown';
import type { Actor } from '../domain-types';
import { displayKey as requirementDisplayKey } from '../requirements/requirements';
import { nodePathTexts } from './links';
import { type LinkTargetType, taskDisplayKey } from './syntax';

export const SUGGESTIONS_PER_KIND = 6;

export type LinkSuggestion = {
  kind: LinkTargetType | 'section';
  /** [[ ]] 里的写法。 */
  insert: string;
  displayKey: string;
  title: string;
  hint: string | null;
  /** sections：选中后不闭合，继续选这份 PRD 的小节。 */
  next: 'insert' | 'sections';
};

const SECTION_QUERY = /^([A-Za-z][A-Za-z0-9]{1,9})-PRD-(\d{1,9})#(.*)$/i;
/** 名称里有这些字符时写不进 [[ ]]，不出现在补全里。 */
const UNLINKABLE = /[[\]|]/;

async function sectionSuggestions(tx: Tx, productId: string | undefined, number: number, partial: string, keyOf: Map<string, string>): Promise<LinkSuggestion[]> {
  if (!productId) return [];
  const [d] = await tx
    .select()
    .from(documents)
    .where(and(eq(documents.productId, productId), eq(documents.number, number), isNull(documents.deletedAt)));
  if (!d) return [];
  const key = documentDisplayKey(keyOf.get(productId)!, d.number);
  const out: LinkSuggestion[] = [{ kind: 'document', insert: key, displayKey: key, title: d.title, hint: '整篇', next: 'insert' }];
  const [rev] = d.currentRevisionId ? await tx.select({ snapshot: documentRevisions.snapshot }).from(documentRevisions).where(eq(documentRevisions.id, d.currentRevisionId)) : [];
  const want = normalizeHeading(partial);
  const seen = new Set<string>();
  for (const s of splitSections(rev?.snapshot.markdown ?? '')) {
    if (!s.heading) continue;
    const h = normalizeHeading(s.heading);
    if (!h || seen.has(h) || UNLINKABLE.test(h) || (want && !h.includes(want))) continue;
    seen.add(h);
    out.push({ kind: 'section', insert: `${key}#${h}`, displayKey: `${key}#${h}`, title: s.heading, hint: null, next: 'insert' });
  }
  return out;
}

/**
 * [[ 补全：只在查看者能看到的产品里搜。编号以输入开头（大小写不敏感，如 PAN-1、pan-prd、PAN-T-）或纯数字等于编号，
 * 或标题（任务另含别名，迭代与节点为名称）包含输入；需求与 PRD 本产品优先。查询为空时只给本产品最近更新的需求与 PRD。
 */
export async function searchLinkTargets(db: Db, actor: Actor, input: { productId: string; q: string }): Promise<LinkSuggestion[]> {
  return withOrg(db, actor.orgId, async (tx) => {
    await requireProductRole(tx, actor, input.productId, 'viewer');
    const visible = [...(await visibleProductIds(tx, actor))];
    const prods = await tx.select({ id: products.id, key: products.key }).from(products).where(inArray(products.id, visible));
    const keyOf = new Map(prods.map((p) => [p.id, p.key]));
    const idOfKey = new Map(prods.map((p) => [p.key, p.id]));
    const own = input.productId;
    const q = input.q.trim();
    const sec = SECTION_QUERY.exec(q);
    if (sec) return sectionSuggestions(tx, idOfKey.get(sec[1]!.toUpperCase()), Number(sec[2]), sec[3]!, keyOf);
    const escaped = q.replace(/[\\%_]/g, (c) => `\\${c}`);
    const like = `%${escaped}%`;
    const prefix = `${escaped}%`;
    const digits = /^\d{1,9}$/.test(q) ? Number(q) : null;
    const out: LinkSuggestion[] = [];

    const reqRows = await tx
      .select({ r: requirements, key: products.key })
      .from(requirements)
      .innerJoin(products, eq(products.id, requirements.productId))
      .where(
        and(
          inArray(requirements.productId, visible),
          isNull(requirements.deletedAt),
          q
            ? or(ilike(requirements.title, like), ilike(sql`${products.key} || '-' || ${requirements.number}`, prefix), ...(digits === null ? [] : [eq(requirements.number, digits)]))
            : eq(requirements.productId, own),
        ),
      )
      .orderBy(sql`(${requirements.productId} = ${own}) desc`, desc(requirements.updatedAt), desc(requirements.number))
      .limit(SUGGESTIONS_PER_KIND);
    for (const { r, key } of reqRows) {
      const k = requirementDisplayKey(key, r.number);
      out.push({ kind: 'requirement', insert: k, displayKey: k, title: r.title, hint: null, next: 'insert' });
    }

    const docRows = await tx
      .select({ d: documents, key: products.key })
      .from(documents)
      .innerJoin(products, eq(products.id, documents.productId))
      .where(
        and(
          inArray(documents.productId, visible),
          eq(documents.kind, 'change'),
          isNull(documents.deletedAt),
          q
            ? or(ilike(documents.title, like), ilike(sql`${products.key} || '-PRD-' || ${documents.number}`, prefix), ...(digits === null ? [] : [eq(documents.number, digits)]))
            : eq(documents.productId, own),
        ),
      )
      .orderBy(sql`(${documents.productId} = ${own}) desc`, desc(documents.updatedAt), desc(documents.number))
      .limit(SUGGESTIONS_PER_KIND);
    for (const { d, key } of docRows) {
      const k = documentDisplayKey(key, d.number);
      out.push({ kind: 'document', insert: k, displayKey: k, title: d.title, hint: null, next: 'sections' });
    }
    if (!q) return out;

    const taskRows = await tx
      .select({ x: tasks, key: products.key })
      .from(tasks)
      .innerJoin(products, eq(products.id, tasks.productId))
      .where(
        and(
          inArray(tasks.productId, visible),
          or(ilike(tasks.title, like), ilike(tasks.alias, like), ilike(sql`${products.key} || '-T-' || ${tasks.number}`, prefix), ...(digits === null ? [] : [eq(tasks.number, digits)])),
        ),
      )
      .orderBy(sql`(${tasks.productId} = ${own}) desc`, desc(tasks.createdAt), desc(tasks.number))
      .limit(SUGGESTIONS_PER_KIND);
    for (const { x, key } of taskRows) {
      const k = taskDisplayKey(key, x.number);
      out.push({ kind: 'task', insert: k, displayKey: k, title: x.title, hint: null, next: 'insert' });
    }

    const iterRows = await tx
      .select()
      .from(iterations)
      .where(and(isNull(iterations.deletedAt), ilike(iterations.name, like), or(inArray(iterations.productId, visible), eq(iterations.type, 'special'))))
      .orderBy(sql`(${iterations.productId} = ${own}) desc nulls last`, desc(iterations.startDate))
      .limit(SUGGESTIONS_PER_KIND * 2);
    for (const i of iterRows.filter((x) => !UNLINKABLE.test(x.name)).slice(0, SUGGESTIONS_PER_KIND)) {
      const pre = i.productId && i.productId !== own ? `${keyOf.get(i.productId)}/` : '';
      const insert = `${pre}迭代:${i.name}`;
      out.push({ kind: 'iteration', insert, displayKey: insert, title: `${i.startDate} ~ ${i.endDate}`, hint: i.type === 'special' ? '专项' : null, next: 'insert' });
    }

    const nodeRows = await tx
      .select()
      .from(structureNodes)
      .where(and(inArray(structureNodes.productId, visible), ilike(structureNodes.name, like)))
      .orderBy(sql`(${structureNodes.productId} = ${own}) desc`, asc(structureNodes.depth), asc(structureNodes.sort))
      .limit(SUGGESTIONS_PER_KIND * 2);
    const paths = new Map<string, Map<string, string>>();
    let added = 0;
    for (const n of nodeRows) {
      if (added >= SUGGESTIONS_PER_KIND) break;
      if (!paths.has(n.productId)) paths.set(n.productId, await nodePathTexts(tx, n.productId));
      const full = paths.get(n.productId)!.get(n.id)!;
      const path = full.slice(keyOf.get(n.productId)!.length + 1);
      // 路径段数与层级不一致说明某一级名称里有「/」，同样写不进 [[ ]]
      if (UNLINKABLE.test(path) || path.split('/').length !== n.depth) continue;
      const insert = n.productId === own ? path : full;
      out.push({ kind: 'structure_node', insert, displayKey: insert, title: n.description ?? '', hint: null, next: 'insert' });
      added += 1;
    }
    return out;
  });
}
