import { eq } from 'drizzle-orm';
import { requireProductRole } from '../access/permissions';
import type { Db } from '../db/client';
import { fieldDefinitions, fieldValues, requirements, stateTransitions } from '../db/schema';
import { withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import { requirementCheckStates } from './check-views';
import { assertCheckState, type SignInput, writeSignoff, writeSingleCheck } from './check-writes';
import { effectiveFields, loadRequirementForUpdate, productWorkflowBody } from './context';
import type { CheckState } from './labels';
import { findTransitionRule, unmetConditions } from './workflow-runtime';

export async function transitionRequirement(
  db: Db,
  actor: Actor,
  requirementId: string,
  input: { to: string; force?: boolean; reason?: string },
): Promise<{ stateKey: string }> {
  return withOrg(db, actor.orgId, async (tx) => {
    const cur = await loadRequirementForUpdate(tx, requirementId);
    const role = await requireProductRole(tx, actor, cur.productId, 'editor');
    const body = await productWorkflowBody(tx, cur.productId);
    const target = body.states.find((s) => s.key === input.to);
    if (!target) throw new AppError('invalid', '目标状态不存在');
    if (input.to === cur.stateKey) throw new AppError('invalid', '需求已处于该状态');
    const reason = input.reason?.trim() || null;
    if (input.force) {
      if (role !== 'admin') throw new AppError('forbidden', '只有产品管理员可以强制流转');
      if (!reason || reason.length > 500) throw new AppError('invalid', '强制流转必须填写原因（不超过 500 个字符）');
    } else {
      const from = body.states.find((s) => s.key === cur.stateKey)?.label ?? cur.stateKey;
      const rule = findTransitionRule(body, cur.stateKey, input.to);
      if (!rule) throw new AppError('invalid', `不能从「${from}」流转到「${target.label}」`);
      const fields = await effectiveFields(tx, cur.productId);
      const filled = await tx
        .selectDistinct({ key: fieldDefinitions.key })
        .from(fieldValues)
        .innerJoin(fieldDefinitions, eq(fieldDefinitions.id, fieldValues.fieldId))
        .where(eq(fieldValues.entityId, requirementId));
      const unmet = unmetConditions(
        rule.conditions,
        {
          checks: await requirementCheckStates(tx, body, cur),
          filledFields: new Set(filled.map((f) => f.key)),
          hasIteration: cur.iterationId !== null,
          hasChangeDocument: cur.changeDocumentId !== null,
        },
        { checkItem: (k) => body.checkItems.find((c) => c.key === k)?.label ?? k, field: (k) => fields.get(k)?.label ?? k },
      );
      if (unmet.length > 0) throw new AppError('invalid', '流转条件未满足', { unmet: unmet.map((u) => u.message) });
    }
    const now = new Date();
    await tx.update(requirements).set({ stateKey: input.to, stateChangedAt: now, updatedAt: now }).where(eq(requirements.id, requirementId));
    await tx.insert(stateTransitions).values({
      orgId: actor.orgId,
      requirementId,
      fromState: cur.stateKey,
      toState: input.to,
      actorMemberId: actor.memberId,
      tokenId: actor.tokenId,
      forced: !!input.force,
      reason: input.force ? reason : null,
      at: now,
    });
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: cur.productId,
      type: 'requirement.state_changed',
      subjectType: 'requirement',
      subjectId: requirementId,
      actor,
      payload: { changes: [{ field: 'stateKey', old: cur.stateKey, new: input.to }], forced: !!input.force, reason: input.force ? reason : null },
    });
    return { stateKey: input.to };
  });
}

export async function setCheckItemState(
  db: Db,
  actor: Actor,
  requirementId: string,
  itemKey: string,
  input: { state: CheckState; note?: string | null },
): Promise<{ state: CheckState }> {
  assertCheckState(input.state);
  return withOrg(db, actor.orgId, async (tx) => {
    const cur = await loadRequirementForUpdate(tx, requirementId);
    await requireProductRole(tx, actor, cur.productId, 'editor');
    const body = await productWorkflowBody(tx, cur.productId);
    const item = body.checkItems.find((c) => c.key === itemKey && c.scope === 'requirement');
    if (!item) throw new AppError('not_found', '检查项不存在');
    if (item.auto === 'prd_status' && cur.changeDocumentId) throw new AppError('invalid', '「PRD」检查项跟随所挂 PRD 的状态，不能手动修改');
    const changes = await writeSingleCheck(tx, actor, { type: 'requirement', id: requirementId }, item, input);
    await tx.update(requirements).set({ updatedAt: new Date() }).where(eq(requirements.id, requirementId));
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: cur.productId,
      type: 'check_item.updated',
      subjectType: 'requirement',
      subjectId: requirementId,
      actor,
      payload: { itemKey, changes },
    });
    return { state: input.state };
  });
}

export async function signCheckItem(db: Db, actor: Actor, requirementId: string, itemKey: string, input: SignInput): Promise<{ state: CheckState }> {
  if (actor.tokenScope?.access === 'read') throw new AppError('forbidden', '只读 Token 不能签字');
  return withOrg(db, actor.orgId, async (tx) => {
    const cur = await loadRequirementForUpdate(tx, requirementId);
    const role = await requireProductRole(tx, actor, cur.productId, 'viewer');
    const body = await productWorkflowBody(tx, cur.productId);
    const item = body.checkItems.find((c) => c.key === itemKey && c.scope === 'requirement');
    if (!item) throw new AppError('not_found', '检查项不存在');
    const r = await writeSignoff(tx, actor, role, { type: 'requirement', id: requirementId }, item, input);
    await tx.update(requirements).set({ updatedAt: new Date() }).where(eq(requirements.id, requirementId));
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: cur.productId,
      type: 'check_item.signed',
      subjectType: 'requirement',
      subjectId: requirementId,
      actor,
      payload: { itemKey, ruleIndex: r.ruleIndex, decision: input.decision, onBehalf: !!input.onBehalf, changes: r.old === r.state ? [] : [{ field: 'state', old: r.old, new: r.state }] },
    });
    return { state: r.state };
  });
}
