import { and, eq, isNull } from 'drizzle-orm';
import { requireProductRole } from '../access/permissions';
import type { Db } from '../db/client';
import { checkItemResults, fieldDefinitions, fieldValues, iterations, requirements } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { WorkflowBody } from '../definitions/workflow-schema';
import type { Actor } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import { effectiveFields, loadRequirementForUpdate, productWorkflowBody } from '../requirements/context';
import { checkStatesFor, type UnmetCondition, unmetConditions } from '../requirements/workflow-runtime';

type ReqRow = typeof requirements.$inferSelect;

/** 流程 actionGates 中 join_iteration 未满足的条件；流程没有配置时返回空数组。 */
export async function joinIterationUnmet(tx: Tx, body: WorkflowBody, req: ReqRow): Promise<UnmetCondition[]> {
  const gate = body.actionGates.find((g) => g.action === 'join_iteration');
  if (!gate || gate.conditions.length === 0) return [];
  const results = await tx
    .select({ itemKey: checkItemResults.itemKey, state: checkItemResults.state })
    .from(checkItemResults)
    .where(and(eq(checkItemResults.targetType, 'requirement'), eq(checkItemResults.targetId, req.id)));
  const fields = await effectiveFields(tx, req.productId);
  const filled = await tx
    .selectDistinct({ key: fieldDefinitions.key })
    .from(fieldValues)
    .innerJoin(fieldDefinitions, eq(fieldDefinitions.id, fieldValues.fieldId))
    .where(eq(fieldValues.entityId, req.id));
  return unmetConditions(
    gate.conditions,
    {
      checks: checkStatesFor(body, results),
      filledFields: new Set(filled.map((f) => f.key)),
      hasIteration: req.iterationId !== null,
      hasChangeDocument: req.changeDocumentId !== null,
    },
    { checkItem: (k) => body.checkItems.find((c) => c.key === k)?.label ?? k, field: (k) => fields.get(k)?.label ?? k },
  );
}

export async function setRequirementIteration(
  db: Db,
  actor: Actor,
  requirementId: string,
  input: { iterationId: string | null; force?: boolean; reason?: string },
): Promise<{ iteration: { id: string; name: string } | null }> {
  return withOrg(db, actor.orgId, async (tx) => {
    const cur = await loadRequirementForUpdate(tx, requirementId);
    const role = await requireProductRole(tx, actor, cur.productId, 'editor');
    const record = async (next: { id: string; name: string } | null, forced: boolean, reason: string | null) => {
      await tx.update(requirements).set({ iterationId: next?.id ?? null, updatedAt: new Date() }).where(eq(requirements.id, requirementId));
      await recordEvent(tx, {
        orgId: actor.orgId,
        productId: cur.productId,
        type: 'requirement.iteration_changed',
        subjectType: 'requirement',
        subjectId: requirementId,
        actor,
        payload: { changes: [{ field: 'iterationId', old: cur.iterationId, new: next?.id ?? null }], iterationName: next?.name ?? null, forced, reason },
      });
    };

    if (input.iterationId === null) {
      if (cur.iterationId !== null) await record(null, false, null);
      return { iteration: null };
    }

    if (cur.iterationId === input.iterationId) {
      const [it] = await tx.select().from(iterations).where(and(eq(iterations.id, input.iterationId), isNull(iterations.deletedAt)));
      if (!it) throw new AppError('not_found', '迭代不存在');
      return { iteration: { id: it.id, name: it.name } };
    }

    // 与开始迭代（FOR UPDATE）互斥，保证承诺快照与加入操作的先后一致
    const [it] = await tx
      .select()
      .from(iterations)
      .where(and(eq(iterations.id, input.iterationId), isNull(iterations.deletedAt)))
      .for('share');
    if (!it) throw new AppError('not_found', '迭代不存在');
    if (it.type === 'regular' && it.productId !== cur.productId) throw new AppError('invalid', '不能加入其他产品的迭代');
    if (it.status !== 'planning' && it.status !== 'active') throw new AppError('invalid', '只能加入规划中或进行中的迭代');
    const target = { id: it.id, name: it.name };

    const reason = input.reason?.trim() || null;
    if (input.force) {
      if (role !== 'admin') throw new AppError('forbidden', '只有产品管理员可以强制加入迭代');
      if (!reason || reason.length > 500) throw new AppError('invalid', '强制加入迭代必须填写原因（不超过 500 个字符）');
    } else {
      const unmet = await joinIterationUnmet(tx, await productWorkflowBody(tx, cur.productId), cur);
      if (unmet.length > 0) throw new AppError('precondition_failed', '加入迭代的条件未满足', { unmet: unmet.map((u) => u.message) });
    }
    await record(target, !!input.force, input.force ? reason : null);
    return { iteration: target };
  });
}
