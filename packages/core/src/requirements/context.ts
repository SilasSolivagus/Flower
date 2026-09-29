import { and, asc, eq, inArray, isNull, or } from 'drizzle-orm';
import { fieldDefinitions, fieldOptions, members, products, requirements, workflowVersions } from '../db/schema';
import type { Tx } from '../db/tx';
import type { WorkflowBody } from '../definitions/workflow-schema';
import { AppError } from '../errors';

export type EffectiveField = {
  id: string;
  key: string;
  label: string;
  cardinality: 'single' | 'multi';
  options: Array<{ id: string; key: string; label: string; color: string | null; active: boolean }>;
};

export async function productWorkflowBody(tx: Tx, productId: string): Promise<WorkflowBody> {
  const [row] = await tx
    .select({ body: workflowVersions.body })
    .from(products)
    .innerJoin(workflowVersions, eq(workflowVersions.id, products.workflowVersionId))
    .where(eq(products.id, productId));
  if (!row) throw new AppError('invalid', '该产品尚未指定流程');
  return row.body as WorkflowBody;
}

export async function effectiveFields(tx: Tx, productId: string): Promise<Map<string, EffectiveField>> {
  const defs = await tx
    .select()
    .from(fieldDefinitions)
    .where(or(isNull(fieldDefinitions.productId), eq(fieldDefinitions.productId, productId)));
  const chosen = new Map<string, (typeof defs)[number]>();
  for (const d of defs) {
    const cur = chosen.get(d.key);
    if (!cur || (cur.productId === null && d.productId !== null)) chosen.set(d.key, d);
  }
  const ids = [...chosen.values()].map((d) => d.id);
  const opts = ids.length ? await tx.select().from(fieldOptions).where(inArray(fieldOptions.fieldId, ids)).orderBy(asc(fieldOptions.sort)) : [];
  return new Map(
    [...chosen.values()].map((d) => [
      d.key,
      {
        id: d.id,
        key: d.key,
        label: d.label,
        cardinality: d.cardinality,
        options: opts
          .filter((o) => o.fieldId === d.id)
          .map((o) => ({ id: o.id, key: o.key, label: o.label, color: o.color, active: o.active })),
      },
    ]),
  );
}

export async function loadRequirement(tx: Tx, id: string): Promise<typeof requirements.$inferSelect> {
  const [r] = await tx.select().from(requirements).where(and(eq(requirements.id, id), isNull(requirements.deletedAt)));
  if (!r) throw new AppError('not_found', '需求不存在');
  return r;
}

export async function memberNames(tx: Tx, ids: Array<string | null>): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (unique.length === 0) return new Map();
  const rows = await tx.select({ id: members.id, name: members.displayName }).from(members).where(inArray(members.id, unique));
  return new Map(rows.map((r) => [r.id, r.name]));
}

export async function assertMemberInOrg(tx: Tx, id: string): Promise<void> {
  const [m] = await tx.select({ id: members.id }).from(members).where(eq(members.id, id));
  if (!m) throw new AppError('not_found', '成员不存在');
}
