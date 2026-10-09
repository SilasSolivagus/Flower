import { and, asc, eq, inArray, isNull, or } from 'drizzle-orm';
import { productRoleOf } from '../access/permissions';
import type { Db } from '../db/client';
import {
  blockers,
  documents,
  entityAliases,
  fieldDefinitions,
  fieldOptions,
  fieldValues,
  functionTags,
  products,
  releases,
  requirementAssignments,
  requirementRelations,
  requirementReleases,
  requirements,
  stateTransitions,
  tasks,
} from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { DocumentStatus } from '../documents/constants';
import { documentDisplayKey, prdCheckState } from '../documents/markdown';
import type { Actor, ProductRole } from '../domain-types';
import { AppError } from '../errors';
import { joinIterationUnmet } from '../iterations/membership';
import { type LinkCard, linkCardsFor, sourceKey } from '../links/cards';
import { taskDisplayKey } from '../links/syntax';
import { buildCheckItemViews, type CheckItemView, requirementCheckStates } from './check-views';
import { effectiveFields, memberNames, productWorkflowBody } from './context';
import { displayKey, hydrateList, type MemberRef, type OptionRef, type RequirementListItem } from './requirements';
import { availableTransitions, type TransitionOption, type UnmetCondition } from './workflow-runtime';

export type RequirementDetail = RequirementListItem & {
  productKey: string;
  description: string;
  /** 描述里 [[ ]] 的链接卡。 */
  links: LinkCard[];
  createdAt: Date;
  stateChangedAt: Date;
  myRole: ProductRole;
  canForce: boolean;
  workflow: { states: Array<{ key: string; label: string; color: string; category: string; group: string; order: number }> };
  fields: Array<{ key: string; label: string; cardinality: 'single' | 'multi'; options: OptionRef[] }>;
  checkItems: CheckItemView[];
  /** 所挂的变更 PRD。 */
  changeDocument: { id: string; displayKey: string; title: string; status: DocumentStatus; source: 'native' | 'external' } | null;
  /** 所挂 PRD 上作用于 PRD 的检查项（覆盖的需求共享）。 */
  documentCheckItems: CheckItemView[];
  transitions: TransitionOption[];
  joinIterationUnmet: UnmetCondition[];
  history: Array<{ from: string | null; to: string; actor: MemberRef | null; forced: boolean; reason: string | null; at: Date }>;
  assignments: Array<{ id: string; member: MemberRef; functionTag: { id: string; name: string } | null; platform: OptionRef | null }>;
  blockers: Array<{ id: string; description: string; status: 'active' | 'resolved'; owner: MemberRef | null; createdAt: Date; resolvedAt: Date | null }>;
  relations: Array<{ id: string; type: string; direction: 'out' | 'in'; other: { id: string; displayKey: string; title: string } }>;
  releases: Array<{ id: string; versionName: string; platform: OptionRef | null; status: 'planned' | 'released'; releasedAt: Date | null }>;
  tasks: Array<{ id: string; displayKey: string; title: string; assignee: MemberRef | null; status: 'todo' | 'doing' | 'done'; planStart: string | null; planDays: number | null }>;
  aliases: string[];
};

async function resolveKey(tx: Tx, key: string): Promise<typeof requirements.$inferSelect> {
  const m = /^([A-Z][A-Z0-9]{1,9})-(\d{1,9})$/.exec(key.trim());
  let row: typeof requirements.$inferSelect | undefined;
  if (m) {
    [row] = await tx
      .select({ r: requirements })
      .from(requirements)
      .innerJoin(products, eq(products.id, requirements.productId))
      .where(and(eq(products.key, m[1]!), eq(requirements.number, Number(m[2])), isNull(requirements.deletedAt), isNull(products.deletedAt)))
      .then((rows) => rows.map((x) => x.r));
  }
  if (!row) {
    const [alias] = await tx.select().from(entityAliases).where(and(eq(entityAliases.alias, key.trim()), eq(entityAliases.entityType, 'requirement')));
    if (alias) [row] = await tx.select().from(requirements).where(and(eq(requirements.id, alias.entityId), isNull(requirements.deletedAt)));
  }
  if (!row) throw new AppError('not_found', '需求不存在');
  return row;
}

export async function getRequirementByKey(db: Db, actor: Actor, key: string): Promise<RequirementDetail> {
  return withOrg(db, actor.orgId, async (tx) => {
    const row = await resolveKey(tx, key);
    const role = await productRoleOf(tx, actor, row.productId);
    if (!role) throw new AppError('not_found', '需求不存在');
    const [product] = await tx.select({ key: products.key }).from(products).where(eq(products.id, row.productId));
    const [base] = await hydrateList(tx, product!.key, [row]);
    const body = await productWorkflowBody(tx, row.productId);
    const fields = await effectiveFields(tx, row.productId);

    const values = await tx
      .select({ fieldId: fieldValues.fieldId, fieldKey: fieldDefinitions.key, id: fieldOptions.id, key: fieldOptions.key, label: fieldOptions.label, color: fieldOptions.color, sort: fieldOptions.sort })
      .from(fieldValues)
      .innerJoin(fieldDefinitions, eq(fieldDefinitions.id, fieldValues.fieldId))
      .innerJoin(fieldOptions, eq(fieldOptions.id, fieldValues.optionId))
      .where(eq(fieldValues.entityId, row.id));
    const fieldList = [...fields.values()].map((f) => ({
      key: f.key,
      label: f.label,
      cardinality: f.cardinality,
      options: values
        .filter((v) => v.fieldKey === f.key)
        .sort((a, b) => a.sort - b.sort)
        .map((v) => ({ id: v.id, key: v.key, label: v.label, color: v.color })),
    }));

    const history = await tx
      .select()
      .from(stateTransitions)
      .where(eq(stateTransitions.requirementId, row.id))
      .orderBy(asc(stateTransitions.at), asc(stateTransitions.id));
    const assignments = await tx.select().from(requirementAssignments).where(eq(requirementAssignments.requirementId, row.id));
    const blockerRows = await tx.select().from(blockers).where(eq(blockers.requirementId, row.id)).orderBy(asc(blockers.createdAt));
    const relationRows = await tx
      .select()
      .from(requirementRelations)
      .where(or(eq(requirementRelations.fromId, row.id), eq(requirementRelations.toId, row.id)));
    const releaseRows = await tx
      .select({ r: releases })
      .from(requirementReleases)
      .innerJoin(releases, eq(releases.id, requirementReleases.releaseId))
      .where(eq(requirementReleases.requirementId, row.id));
    const taskRows = await tx.select().from(tasks).where(eq(tasks.requirementId, row.id)).orderBy(asc(tasks.planStart), asc(tasks.createdAt));
    const aliasRows = await tx.select({ alias: entityAliases.alias }).from(entityAliases).where(eq(entityAliases.entityId, row.id));
    const [docRow] = row.changeDocumentId ? await tx.select().from(documents).where(and(eq(documents.id, row.changeDocumentId), isNull(documents.deletedAt))) : [];

    const names = await memberNames(tx, [
      ...history.map((h) => h.actorMemberId),
      ...assignments.map((a) => a.memberId),
      ...blockerRows.map((b) => b.ownerMemberId),
      ...taskRows.map((x) => x.assigneeMemberId),
    ]);
    const ref = (id: string | null): MemberRef | null => (id ? { id, displayName: names.get(id) ?? '已删除的成员' } : null);
    const tagIds = [...new Set(assignments.map((a) => a.functionTagId).filter((x): x is string => !!x))];
    const tagRows = tagIds.length ? await tx.select({ id: functionTags.id, name: functionTags.name }).from(functionTags).where(inArray(functionTags.id, tagIds)) : [];
    const tagName = new Map(tagRows.map((x) => [x.id, x.name]));
    const optionIds = [
      ...new Set([...assignments.map((a) => a.platformOptionId), ...releaseRows.map((x) => x.r.platformOptionId)].filter((x): x is string => !!x)),
    ];
    const optionRows = optionIds.length ? await tx.select().from(fieldOptions).where(inArray(fieldOptions.id, optionIds)) : [];
    const optionRef = (id: string | null): OptionRef | null => {
      const o = id ? optionRows.find((x) => x.id === id) : undefined;
      return o ? { id: o.id, key: o.key, label: o.label, color: o.color } : null;
    };
    const otherIds = [...new Set(relationRows.map((r) => (r.fromId === row.id ? r.toId : r.fromId)))];
    const otherRows = otherIds.length
      ? await tx
          .select({ r: requirements, productKey: products.key })
          .from(requirements)
          .innerJoin(products, eq(products.id, requirements.productId))
          .where(and(inArray(requirements.id, otherIds), isNull(requirements.deletedAt), isNull(products.deletedAt)))
      : [];
    const otherProductIds = [...new Set(otherRows.map((x) => x.r.productId).filter((id) => id !== row.productId))];
    const otherRoles = new Map<string, ProductRole | null>();
    for (const pid of otherProductIds) otherRoles.set(pid, await productRoleOf(tx, actor, pid));
    const others = otherRows
      .filter((x) => x.r.productId === row.productId || otherRoles.get(x.r.productId))
      .map((x) => ({ id: x.r.id, number: x.r.number, title: x.r.title, productKey: x.productKey }));

    const checkItems = await buildCheckItemViews(tx, actor, role, body.checkItems.filter((c) => c.scope === 'requirement'), { type: 'requirement', id: row.id }, { autoState: docRow ? prdCheckState(docRow.status) : null });
    const documentCheckItems = docRow
      ? await buildCheckItemViews(tx, actor, role, body.checkItems.filter((c) => c.scope === 'document'), { type: 'document', id: docRow.id }, { autoState: null })
      : [];
    const links = (await linkCardsFor(tx, actor, [{ type: 'requirement', id: row.id }])).get(sourceKey('requirement', row.id))!;
    const ctx = {
      checks: await requirementCheckStates(tx, body, row),
      filledFields: new Set(fieldList.filter((f) => f.options.length > 0).map((f) => f.key)),
      hasIteration: row.iterationId !== null,
      hasChangeDocument: row.changeDocumentId !== null,
    };
    const lookup = { checkItem: (k: string) => body.checkItems.find((c) => c.key === k)?.label ?? k, field: (k: string) => fields.get(k)?.label ?? k };

    return {
      ...base!,
      productKey: product!.key,
      description: row.description,
      links,
      createdAt: row.createdAt,
      stateChangedAt: row.stateChangedAt,
      myRole: role,
      canForce: role === 'admin',
      workflow: { states: [...body.states].sort((a, b) => a.order - b.order).map((s) => ({ key: s.key, label: s.label, color: s.color, category: s.category, group: s.group, order: s.order })) },
      fields: fieldList,
      checkItems,
      changeDocument: docRow ? { id: docRow.id, displayKey: documentDisplayKey(product!.key, docRow.number), title: docRow.title, status: docRow.status, source: docRow.source } : null,
      documentCheckItems,
      transitions: availableTransitions(body, row.stateKey, ctx, lookup),
      joinIterationUnmet: await joinIterationUnmet(tx, body, row),
      history: history.map((h) => ({ from: h.fromState, to: h.toState, actor: ref(h.actorMemberId), forced: h.forced, reason: h.reason, at: h.at })),
      assignments: assignments.map((a) => ({
        id: a.id,
        member: ref(a.memberId)!,
        functionTag: a.functionTagId ? { id: a.functionTagId, name: tagName.get(a.functionTagId) ?? '' } : null,
        platform: optionRef(a.platformOptionId),
      })),
      blockers: blockerRows.map((b) => ({ id: b.id, description: b.description, status: b.status, owner: ref(b.ownerMemberId), createdAt: b.createdAt, resolvedAt: b.resolvedAt })),
      relations: relationRows
        .map((r) => {
          const otherId = r.fromId === row.id ? r.toId : r.fromId;
          const o = others.find((x) => x.id === otherId);
          if (!o) return null;
          return { id: r.id, type: r.type, direction: r.fromId === row.id ? ('out' as const) : ('in' as const), other: { id: otherId, displayKey: displayKey(o.productKey, o.number), title: o.title } };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null),
      releases: releaseRows.map(({ r }) => ({ id: r.id, versionName: r.versionName, platform: optionRef(r.platformOptionId), status: r.status, releasedAt: r.releasedAt })),
      tasks: taskRows.map((x) => ({
        id: x.id,
        displayKey: taskDisplayKey(product!.key, x.number),
        title: x.title,
        assignee: ref(x.assigneeMemberId),
        status: x.status,
        planStart: x.planStart,
        planDays: x.planDays,
      })),
      aliases: aliasRows.map((a) => a.alias).sort(),
    };
  });
}
