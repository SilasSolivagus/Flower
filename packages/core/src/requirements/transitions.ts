import { and, asc, eq } from 'drizzle-orm';
import { requireProductRole } from '../access/permissions';
import type { Db } from '../db/client';
import { checkItemResults, checkItemSignoffs, fieldDefinitions, fieldValues, memberFunctionTags, requirements, stateTransitions } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import { CHECK_STATES } from '../definitions/workflow-schema';
import type { Actor } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import { effectiveFields, loadRequirementForUpdate, productWorkflowBody } from './context';
import type { CheckState } from './labels';
import { checkStatesFor, findTransitionRule, matchingSignerRules, signoffResultState, unmetConditions } from './workflow-runtime';

async function ensureResult(tx: Tx, orgId: string, requirementId: string, itemKey: string, defaultState: CheckState) {
  const [existing] = await tx
    .select()
    .from(checkItemResults)
    .where(and(eq(checkItemResults.targetType, 'requirement'), eq(checkItemResults.targetId, requirementId), eq(checkItemResults.itemKey, itemKey)));
  if (existing) return existing;
  const [row] = await tx.insert(checkItemResults).values({ orgId, targetType: 'requirement', targetId: requirementId, itemKey, state: defaultState }).returning();
  return row!;
}

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
      const results = await tx
        .select({ itemKey: checkItemResults.itemKey, state: checkItemResults.state })
        .from(checkItemResults)
        .where(and(eq(checkItemResults.targetType, 'requirement'), eq(checkItemResults.targetId, requirementId)));
      const fields = await effectiveFields(tx, cur.productId);
      const filled = await tx
        .selectDistinct({ key: fieldDefinitions.key })
        .from(fieldValues)
        .innerJoin(fieldDefinitions, eq(fieldDefinitions.id, fieldValues.fieldId))
        .where(eq(fieldValues.entityId, requirementId));
      const unmet = unmetConditions(
        rule.conditions,
        {
          checks: checkStatesFor(body, results),
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
  if (!(CHECK_STATES as readonly string[]).includes(input.state)) throw new AppError('invalid', '检查状态无效');
  return withOrg(db, actor.orgId, async (tx) => {
    const cur = await loadRequirementForUpdate(tx, requirementId);
    await requireProductRole(tx, actor, cur.productId, 'editor');
    const body = await productWorkflowBody(tx, cur.productId);
    const item = body.checkItems.find((c) => c.key === itemKey && c.scope === 'requirement');
    if (!item) throw new AppError('not_found', '检查项不存在');
    if (item.type === 'signoff') throw new AppError('invalid', '会签检查项的状态由签字结果决定');
    const result = await ensureResult(tx, actor.orgId, requirementId, itemKey, item.defaultState);
    const note = input.note === undefined ? result.note : input.note?.trim() || null;
    const now = new Date();
    await tx.update(checkItemResults).set({ state: input.state, note, updatedBy: actor.memberId, updatedAt: now }).where(eq(checkItemResults.id, result.id));
    await tx.update(requirements).set({ updatedAt: now }).where(eq(requirements.id, requirementId));
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: cur.productId,
      type: 'check_item.updated',
      subjectType: 'requirement',
      subjectId: requirementId,
      actor,
      payload: { itemKey, changes: [{ field: 'state', old: result.state, new: input.state }, { field: 'note', old: result.note, new: note }].filter((c) => c.old !== c.new) },
    });
    return { state: input.state };
  });
}

export async function signCheckItem(
  db: Db,
  actor: Actor,
  requirementId: string,
  itemKey: string,
  input: { decision: 'passed' | 'rejected'; note?: string | null; ruleIndex?: number; onBehalf?: boolean },
): Promise<{ state: CheckState }> {
  if (actor.tokenScope?.access === 'read') throw new AppError('forbidden', '只读 Token 不能签字');
  return withOrg(db, actor.orgId, async (tx) => {
    const cur = await loadRequirementForUpdate(tx, requirementId);
    const role = await requireProductRole(tx, actor, cur.productId, 'viewer');
    const body = await productWorkflowBody(tx, cur.productId);
    const item = body.checkItems.find((c) => c.key === itemKey && c.scope === 'requirement');
    if (!item) throw new AppError('not_found', '检查项不存在');
    if (item.type !== 'signoff') throw new AppError('invalid', '该检查项不需要会签');
    let signer = actor.memberId;
    let actedBy: string | null = null;
    let ruleIndex: number;
    if (input.onBehalf) {
      if (role !== 'admin') throw new AppError('forbidden', '只有产品管理员可以代签');
      const rule = input.ruleIndex === undefined ? undefined : item.signers?.[input.ruleIndex];
      if (!rule || rule.by !== 'member') throw new AppError('invalid', '只能代签"指定成员"类的签字规则');
      if (rule.ref === actor.memberId) throw new AppError('invalid', '不能代自己签字');
      ruleIndex = input.ruleIndex!;
      signer = rule.ref;
      actedBy = actor.memberId;
    } else {
      const tags = await tx.select({ tagId: memberFunctionTags.tagId }).from(memberFunctionTags).where(eq(memberFunctionTags.memberId, actor.memberId));
      const matches = matchingSignerRules(item, { memberId: actor.memberId, functionTagIds: tags.map((x) => x.tagId), productRole: role });
      if (matches.length === 0) throw new AppError('forbidden', '你不在该检查项的签字人中');
      if (input.ruleIndex !== undefined && !matches.includes(input.ruleIndex)) throw new AppError('forbidden', '你不能代表这条签字规则签字');
      ruleIndex = input.ruleIndex ?? matches[0]!;
    }
    const result = await ensureResult(tx, actor.orgId, requirementId, itemKey, item.defaultState);
    const now = new Date();
    await tx.insert(checkItemSignoffs).values({
      orgId: actor.orgId,
      resultId: result.id,
      signerMemberId: signer,
      actedByMemberId: actedBy,
      signerRuleIndex: ruleIndex,
      decision: input.decision,
      note: input.note?.trim() || null,
      at: now,
    });
    const all = await tx.select().from(checkItemSignoffs).where(eq(checkItemSignoffs.resultId, result.id)).orderBy(asc(checkItemSignoffs.at), asc(checkItemSignoffs.id));
    const state = signoffResultState(item, all.map((s) => ({ signerRuleIndex: s.signerRuleIndex, decision: s.decision, at: s.at })));
    await tx.update(checkItemResults).set({ state, updatedBy: actor.memberId, updatedAt: now }).where(eq(checkItemResults.id, result.id));
    await tx.update(requirements).set({ updatedAt: now }).where(eq(requirements.id, requirementId));
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: cur.productId,
      type: 'check_item.signed',
      subjectType: 'requirement',
      subjectId: requirementId,
      actor,
      payload: { itemKey, ruleIndex, decision: input.decision, onBehalf: !!input.onBehalf, changes: result.state === state ? [] : [{ field: 'state', old: result.state, new: state }] },
    });
    return { state };
  });
}
