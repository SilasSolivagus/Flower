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

/** 校验平台选项属于本产品的「平台」字段，且未停用（已停用但等于 `previous` 时放行，用于保留原有选择）。 */
export async function assertPlatformOption(tx: Tx, productId: string, optionId: string, previous: string | null): Promise<void> {
  const platform = (await effectiveFields(tx, productId)).get('platform');
  const opt = platform?.options.find((o) => o.id === optionId);
  if (!opt) throw new AppError('invalid', '平台选项不属于本产品的「平台」字段');
  if (!opt.active && optionId !== previous) throw new AppError('invalid', `选项「${opt.label}」已停用`);
}

export async function loadRequirement(tx: Tx, id: string): Promise<typeof requirements.$inferSelect> {
  const [r] = await tx.select().from(requirements).where(and(eq(requirements.id, id), isNull(requirements.deletedAt)));
  if (!r) throw new AppError('not_found', '需求不存在');
  return r;
}

/** 加行锁读取需求：用于状态流转、检查项与签字，避免并发写入基于同一份旧状态重复通过校验。 */
export async function loadRequirementForUpdate(tx: Tx, id: string): Promise<typeof requirements.$inferSelect> {
  const [r] = await tx
    .select()
    .from(requirements)
    .where(and(eq(requirements.id, id), isNull(requirements.deletedAt)))
    .for('update');
  if (!r) throw new AppError('not_found', '需求不存在');
  return r;
}

export async function memberNames(tx: Tx, ids: Array<string | null>): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (unique.length === 0) return new Map();
  const rows = await tx.select({ id: members.id, name: members.displayName }).from(members).where(inArray(members.id, unique));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/**
 * 写入负责人、提出人、任务负责人、需求分配、阻塞项负责人、会签「指定成员」时校验：必须是本组织在职的人类成员。
 * 在 withOrg 事务里调用，其他组织的成员受 RLS 限制查不到，按「不存在」处理。
 */
export async function assertAssignableMember(tx: Tx, id: string): Promise<void> {
  const [m] = await tx.select({ kind: members.kind, status: members.status }).from(members).where(eq(members.id, id));
  if (!m) throw new AppError('invalid', '成员不存在或不属于本组织');
  if (m.kind !== 'human') throw new AppError('invalid', '不能选择 Agent 成员');
  if (m.status !== 'active') throw new AppError('invalid', '该成员已离开组织，不能选择');
}
