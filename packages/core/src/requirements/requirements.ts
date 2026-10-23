import { and, desc, eq, ilike, inArray, isNull, or, type SQL, sql } from 'drizzle-orm';
import { requireProductRole } from '../access/permissions';
import type { Db } from '../db/client';
import {
  fieldDefinitions,
  fieldOptions,
  fieldValues,
  iterations,
  products,
  requirementAssignments,
  requirements,
  stateTransitions,
  structureNodes,
} from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import { autoTrackTx } from '../tracking/requirement-tracking';
import { relinkDangling, syncSourceLinks } from '../links/links';
import { mentionedMemberIds, newMentionIds } from '../links/syntax';
import { assertAssignableMember, type EffectiveField, effectiveFields, loadRequirement, memberNames, productWorkflowBody } from './context';

export type OptionRef = { id: string; key: string; label: string; color: string | null };
export type MemberRef = { id: string; displayName: string };
export type RequirementListItem = {
  id: string;
  productId: string;
  number: number;
  displayKey: string;
  legacyKey: string | null;
  title: string;
  stateKey: string;
  owner: MemberRef | null;
  requester: MemberRef | null;
  priority: OptionRef | null;
  platforms: OptionRef[];
  node: { id: string; name: string } | null;
  iteration: { id: string; name: string } | null;
  updatedAt: Date;
};
export type RequirementFilter = {
  states?: string[];
  nodeIds?: string[];
  priorityOptionIds?: string[];
  platformOptionIds?: string[];
  ownerIds?: string[];
  requesterIds?: string[];
  /** `me`：负责人、提出人或被分配人是当前成员。其它值由 listRequirements 拒绝。 */
  related?: string;
  iterationIds?: string[];
  noIteration?: boolean;
  q?: string;
  sort?: 'updated' | 'number' | 'created';
  page?: number;
  pageSize?: number;
};
export type RequirementList = { items: RequirementListItem[]; total: number; page: number; pageSize: number; stateCounts: Record<string, number> };

type ReqRow = typeof requirements.$inferSelect;

export const displayKey = (productKey: string, number: number): string => `${productKey}-${number}`;

export function assertTitle(title: string): string {
  const t = title.trim();
  if (!t || t.length > 200) throw new AppError('invalid', '标题不能为空，且不超过 200 个字符');
  return t;
}

function assertDescription(d: string): string {
  if (d.length > 50_000) throw new AppError('invalid', '描述不超过 50000 个字符');
  return d;
}

export async function productKeyOf(tx: Tx, productId: string): Promise<string> {
  const [p] = await tx.select({ key: products.key }).from(products).where(eq(products.id, productId));
  if (!p) throw new AppError('not_found', '产品不存在');
  return p.key;
}

async function assertNode(tx: Tx, productId: string, nodeId: string): Promise<void> {
  const [n] = await tx.select({ productId: structureNodes.productId }).from(structureNodes).where(eq(structureNodes.id, nodeId));
  if (!n || n.productId !== productId) throw new AppError('invalid', '结构树节点不属于该产品');
}

function descendantIds(nodes: Array<{ id: string; parentId: string | null }>, roots: string[]): string[] {
  const out = new Set(roots);
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of nodes) {
      if (n.parentId && out.has(n.parentId) && !out.has(n.id)) {
        out.add(n.id);
        grew = true;
      }
    }
  }
  return [...out];
}

function assertRelatedFilter(f: RequirementFilter): void {
  if (f.related === undefined) return;
  if (f.related !== 'me') throw new AppError('INVALID_RELATED', 'related 只能是 me');
  if ((f.ownerIds?.length ?? 0) > 0 || (f.requesterIds?.length ?? 0) > 0) {
    throw new AppError('RELATED_CONFLICT', 'related=me 与 owner/requester 不能同时传');
  }
}

/** 当前成员是负责人、提出人，或在分配表里有一行。exists 避免同一人多条分配把需求算重。 */
function relatedToMember(memberId: string): SQL {
  return or(
    eq(requirements.ownerMemberId, memberId),
    eq(requirements.requesterMemberId, memberId),
    sql`exists (select 1 from ${requirementAssignments} where ${requirementAssignments.requirementId} = ${requirements.id} and ${requirementAssignments.memberId} = ${memberId})`,
  )!;
}

async function filterConditions(tx: Tx, productId: string, f: RequirementFilter, memberId: string): Promise<SQL[]> {
  const conds: SQL[] = [eq(requirements.productId, productId), isNull(requirements.deletedAt)];
  if (f.related === 'me') conds.push(relatedToMember(memberId));
  if (f.nodeIds?.length) {
    const nodes = await tx.select({ id: structureNodes.id, parentId: structureNodes.parentId }).from(structureNodes).where(eq(structureNodes.productId, productId));
    conds.push(inArray(requirements.nodeId, descendantIds(nodes, f.nodeIds)));
  }
  if (f.ownerIds?.length) conds.push(inArray(requirements.ownerMemberId, f.ownerIds));
  if (f.requesterIds?.length) conds.push(inArray(requirements.requesterMemberId, f.requesterIds));
  if (f.noIteration) conds.push(isNull(requirements.iterationId));
  else if (f.iterationIds?.length) conds.push(inArray(requirements.iterationId, f.iterationIds));
  for (const ids of [f.priorityOptionIds, f.platformOptionIds]) {
    if (ids?.length) {
      conds.push(sql`exists (select 1 from ${fieldValues} where ${fieldValues.entityId} = ${requirements.id} and ${inArray(fieldValues.optionId, ids)})`);
    }
  }
  const q = f.q?.trim();
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const num = /^(?:[A-Za-z][A-Za-z0-9]*-)?(\d{1,9})$/.exec(q);
    const parts = [ilike(requirements.title, like), ilike(requirements.legacyKey, like)];
    if (num) parts.push(eq(requirements.number, Number(num[1])));
    conds.push(or(...parts)!);
  }
  return conds;
}

export async function hydrateList(tx: Tx, productKey: string, rows: ReqRow[]): Promise<RequirementListItem[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const names = await memberNames(tx, rows.flatMap((r) => [r.ownerMemberId, r.requesterMemberId]));
  const nodeIds = [...new Set(rows.map((r) => r.nodeId).filter((x): x is string => !!x))];
  const iterIds = [...new Set(rows.map((r) => r.iterationId).filter((x): x is string => !!x))];
  const nodes = nodeIds.length ? await tx.select({ id: structureNodes.id, name: structureNodes.name }).from(structureNodes).where(inArray(structureNodes.id, nodeIds)) : [];
  const iters = iterIds.length ? await tx.select({ id: iterations.id, name: iterations.name }).from(iterations).where(inArray(iterations.id, iterIds)) : [];
  const values = await tx
    .select({
      entityId: fieldValues.entityId,
      fieldKey: fieldDefinitions.key,
      id: fieldOptions.id,
      key: fieldOptions.key,
      label: fieldOptions.label,
      color: fieldOptions.color,
      sort: fieldOptions.sort,
    })
    .from(fieldValues)
    .innerJoin(fieldDefinitions, eq(fieldDefinitions.id, fieldValues.fieldId))
    .innerJoin(fieldOptions, eq(fieldOptions.id, fieldValues.optionId))
    .where(inArray(fieldValues.entityId, ids));
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const iterMap = new Map(iters.map((i) => [i.id, i]));
  const ref = (id: string | null): MemberRef | null => (id && names.has(id) ? { id, displayName: names.get(id)! } : null);
  const opt = (v: (typeof values)[number]): OptionRef => ({ id: v.id, key: v.key, label: v.label, color: v.color });
  return rows.map((r) => {
    const mine = values.filter((v) => v.entityId === r.id).sort((a, b) => a.sort - b.sort);
    const priority = mine.find((v) => v.fieldKey === 'priority');
    return {
      id: r.id,
      productId: r.productId,
      number: r.number,
      displayKey: displayKey(productKey, r.number),
      legacyKey: r.legacyKey,
      title: r.title,
      stateKey: r.stateKey,
      owner: ref(r.ownerMemberId),
      requester: ref(r.requesterMemberId),
      priority: priority ? opt(priority) : null,
      platforms: mine.filter((v) => v.fieldKey === 'platform').map(opt),
      node: r.nodeId ? (nodeMap.get(r.nodeId) ?? null) : null,
      iteration: r.iterationId ? (iterMap.get(r.iterationId) ?? null) : null,
      updatedAt: r.updatedAt,
    };
  });
}

export async function listRequirements(db: Db, actor: Actor, productId: string, filter: RequirementFilter = {}): Promise<RequirementList> {
  assertRelatedFilter(filter);
  return withOrg(db, actor.orgId, async (tx) => {
    await requireProductRole(tx, actor, productId, 'viewer');
    const key = await productKeyOf(tx, productId);
    const base = await filterConditions(tx, productId, filter, actor.memberId);
    const where = filter.states?.length ? and(...base, inArray(requirements.stateKey, filter.states)) : and(...base);
    const [{ total }] = (await tx.select({ total: sql<number>`count(*)::int` }).from(requirements).where(where)) as [{ total: number }];
    const counts = await tx
      .select({ state: requirements.stateKey, n: sql<number>`count(*)::int` })
      .from(requirements)
      .where(and(...base))
      .groupBy(requirements.stateKey);
    const pageSize = Math.min(Math.max(filter.pageSize ?? 50, 1), 200);
    const page = Math.max(filter.page ?? 1, 1);
    const order =
      filter.sort === 'number'
        ? [desc(requirements.number)]
        : filter.sort === 'created'
          ? [desc(requirements.createdAt), desc(requirements.number)]
          : [desc(requirements.updatedAt), desc(requirements.number)];
    const rows = await tx.select().from(requirements).where(where).orderBy(...order).limit(pageSize).offset((page - 1) * pageSize);
    return { items: await hydrateList(tx, key, rows), total, page, pageSize, stateCounts: Object.fromEntries(counts.map((c) => [c.state, c.n])) };
  });
}

function resolveOptions(field: EffectiveField, optionIds: string[], previous: string[] = []): string[] {
  const unique = [...new Set(optionIds)];
  if (field.cardinality === 'single' && unique.length > 1) throw new AppError('invalid', `「${field.label}」只能选择一个值`);
  for (const id of unique) {
    const o = field.options.find((x) => x.id === id);
    if (!o) throw new AppError('invalid', `选项不属于「${field.label}」`);
    if (!o.active && !previous.includes(id)) throw new AppError('invalid', `选项「${o.label}」已停用`);
  }
  return unique;
}

async function replaceFieldValues(tx: Tx, orgId: string, requirementId: string, field: EffectiveField, optionIds: string[]): Promise<void> {
  await tx.delete(fieldValues).where(and(eq(fieldValues.entityId, requirementId), eq(fieldValues.fieldId, field.id)));
  if (optionIds.length > 0) {
    await tx.insert(fieldValues).values(optionIds.map((optionId) => ({ orgId, entityType: 'requirement' as const, entityId: requirementId, fieldId: field.id, optionId })));
  }
}

export async function createRequirement(
  db: Db,
  actor: Actor,
  productId: string,
  input: { title: string; description?: string; ownerMemberId?: string | null; requesterMemberId?: string | null; nodeId?: string | null; fields?: Record<string, string[]> },
): Promise<RequirementListItem> {
  const title = assertTitle(input.title);
  const description = assertDescription(input.description ?? '');
  return withOrg(db, actor.orgId, async (tx) => {
    await requireProductRole(tx, actor, productId, 'editor');
    if (input.ownerMemberId) await assertAssignableMember(tx, input.ownerMemberId);
    if (input.requesterMemberId) await assertAssignableMember(tx, input.requesterMemberId);
    if (input.nodeId) await assertNode(tx, productId, input.nodeId);
    const fields = await effectiveFields(tx, productId);
    const values: Array<[EffectiveField, string[]]> = [];
    for (const [key, ids] of Object.entries(input.fields ?? {})) {
      const field = fields.get(key);
      if (!field) throw new AppError('not_found', `字段「${key}」不存在`);
      values.push([field, resolveOptions(field, ids)]);
    }
    const body = await productWorkflowBody(tx, productId);
    const [seq] = await tx
      .update(products)
      .set({ requirementSeq: sql`${products.requirementSeq} + 1` })
      .where(eq(products.id, productId))
      .returning({ n: products.requirementSeq, key: products.key });
    const [row] = await tx
      .insert(requirements)
      .values({
        orgId: actor.orgId,
        productId,
        number: seq!.n,
        title,
        description,
        stateKey: body.initial,
        ownerMemberId: input.ownerMemberId ?? null,
        requesterMemberId: input.requesterMemberId ?? null,
        nodeId: input.nodeId ?? null,
        createdBy: actor.memberId,
      })
      .returning();
    await tx.insert(stateTransitions).values({ orgId: actor.orgId, requirementId: row!.id, fromState: null, toState: body.initial, actorMemberId: actor.memberId, tokenId: actor.tokenId });
    for (const [field, ids] of values) await replaceFieldValues(tx, actor.orgId, row!.id, field, ids);
    await syncSourceLinks(tx, actor.orgId, { type: 'requirement', id: row!.id, productKey: seq!.key }, description);
    await relinkDangling(tx, { type: 'requirement', id: row!.id, texts: [displayKey(seq!.key, row!.number)] });
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId,
      type: 'requirement.created',
      subjectType: 'requirement',
      subjectId: row!.id,
      actor,
      payload: { number: row!.number, title, ownerMemberId: row!.ownerMemberId, mentionedMemberIds: mentionedMemberIds(description) },
    });
    const initialCategory = body.states.find((s) => s.key === body.initial)?.category ?? 'backlog';
    await autoTrackTx(tx, actor, row!, initialCategory, row!.createdAt);
    const [item] = await hydrateList(tx, seq!.key, [row!]);
    return item!;
  });
}

export async function updateRequirement(
  db: Db,
  actor: Actor,
  requirementId: string,
  input: { title?: string; description?: string; ownerMemberId?: string | null; requesterMemberId?: string | null; nodeId?: string | null },
): Promise<RequirementListItem> {
  return withOrg(db, actor.orgId, async (tx) => {
    const cur = await loadRequirement(tx, requirementId);
    await requireProductRole(tx, actor, cur.productId, 'editor');
    const next = {
      title: input.title === undefined ? cur.title : assertTitle(input.title),
      description: input.description === undefined ? cur.description : assertDescription(input.description),
      ownerMemberId: input.ownerMemberId === undefined ? cur.ownerMemberId : input.ownerMemberId,
      requesterMemberId: input.requesterMemberId === undefined ? cur.requesterMemberId : input.requesterMemberId,
      nodeId: input.nodeId === undefined ? cur.nodeId : input.nodeId,
    };
    if (next.ownerMemberId && next.ownerMemberId !== cur.ownerMemberId) await assertAssignableMember(tx, next.ownerMemberId);
    if (next.requesterMemberId && next.requesterMemberId !== cur.requesterMemberId) await assertAssignableMember(tx, next.requesterMemberId);
    if (next.nodeId && next.nodeId !== cur.nodeId) await assertNode(tx, cur.productId, next.nodeId);
    const changes = (Object.keys(next) as Array<keyof typeof next>)
      .map((field) => ({ field, old: cur[field], new: next[field] }))
      .filter((c) => c.old !== c.new);
    const [row] = await tx
      .update(requirements)
      .set({ ...next, updatedAt: changes.length ? new Date() : cur.updatedAt })
      .where(eq(requirements.id, requirementId))
      .returning();
    if (next.description !== cur.description) {
      await syncSourceLinks(tx, actor.orgId, { type: 'requirement', id: requirementId, productKey: await productKeyOf(tx, cur.productId) }, next.description);
    }
    if (changes.length) {
      await recordEvent(tx, {
        orgId: actor.orgId,
        productId: cur.productId,
        type: 'requirement.updated',
        subjectType: 'requirement',
        subjectId: requirementId,
        actor,
        payload: { changes, ...(next.description !== cur.description ? { mentionedMemberIds: newMentionIds(cur.description, next.description) } : {}) },
      });
    }
    const [item] = await hydrateList(tx, await productKeyOf(tx, cur.productId), [row!]);
    return item!;
  });
}

export async function setRequirementField(db: Db, actor: Actor, requirementId: string, fieldKey: string, optionIds: string[]): Promise<OptionRef[]> {
  return withOrg(db, actor.orgId, async (tx) => {
    const cur = await loadRequirement(tx, requirementId);
    await requireProductRole(tx, actor, cur.productId, 'editor');
    const field = (await effectiveFields(tx, cur.productId)).get(fieldKey);
    if (!field) throw new AppError('not_found', `字段「${fieldKey}」不存在`);
    const before = await tx
      .select({ optionId: fieldValues.optionId })
      .from(fieldValues)
      .where(and(eq(fieldValues.entityId, requirementId), eq(fieldValues.fieldId, field.id)));
    const previous = before.map((b) => b.optionId);
    const ids = resolveOptions(field, optionIds, previous);
    await replaceFieldValues(tx, actor.orgId, requirementId, field, ids);
    await tx.update(requirements).set({ updatedAt: new Date() }).where(eq(requirements.id, requirementId));
    const label = (id: string) => field.options.find((o) => o.id === id)?.label ?? id;
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: cur.productId,
      type: 'requirement.field_changed',
      subjectType: 'requirement',
      subjectId: requirementId,
      actor,
      payload: { changes: [{ field: fieldKey, old: previous.map(label), new: ids.map(label) }] },
    });
    return ids.map((id) => {
      const o = field.options.find((x) => x.id === id)!;
      return { id: o.id, key: o.key, label: o.label, color: o.color };
    });
  });
}
