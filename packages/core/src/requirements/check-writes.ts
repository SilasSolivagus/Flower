import { and, asc, eq } from 'drizzle-orm';
import { checkItemResults, checkItemSignoffs, memberFunctionTags } from '../db/schema';
import type { Tx } from '../db/tx';
import { CHECK_STATES } from '../definitions/workflow-schema';
import type { Actor, ProductRole } from '../domain-types';
import { AppError } from '../errors';
import type { CheckState } from './labels';
import { type CheckItem, matchingSignerRules, signoffResultState } from './workflow-runtime';

export type CheckTarget = { type: 'requirement' | 'document'; id: string };
export type SignInput = { decision: 'passed' | 'rejected'; note?: string | null; ruleIndex?: number; onBehalf?: boolean };

export function assertCheckState(state: string): void {
  if (!(CHECK_STATES as readonly string[]).includes(state)) throw new AppError('invalid', '检查状态无效');
}

async function ensureResult(tx: Tx, orgId: string, target: CheckTarget, itemKey: string, defaultState: CheckState) {
  const [existing] = await tx
    .select()
    .from(checkItemResults)
    .where(and(eq(checkItemResults.targetType, target.type), eq(checkItemResults.targetId, target.id), eq(checkItemResults.itemKey, itemKey)));
  if (existing) return existing;
  const [row] = await tx.insert(checkItemResults).values({ orgId, targetType: target.type, targetId: target.id, itemKey, state: defaultState }).returning();
  return row!;
}

/** 普通检查项改状态与备注，返回修改事件用的 changes。调用方已锁住对象并校验了权限。 */
export async function writeSingleCheck(
  tx: Tx,
  actor: Actor,
  target: CheckTarget,
  item: CheckItem,
  input: { state: CheckState; note?: string | null },
): Promise<Array<{ field: string; old: unknown; new: unknown }>> {
  if (item.type === 'signoff') throw new AppError('invalid', '会签检查项的状态由签字结果决定');
  const result = await ensureResult(tx, actor.orgId, target, item.key, item.defaultState);
  const note = input.note === undefined ? result.note : input.note?.trim() || null;
  await tx.update(checkItemResults).set({ state: input.state, note, updatedBy: actor.memberId, updatedAt: new Date() }).where(eq(checkItemResults.id, result.id));
  return [
    { field: 'state', old: result.state, new: input.state },
    { field: 'note', old: result.note, new: note },
  ].filter((c) => c.old !== c.new);
}

/**
 * 会签：本人按匹配的签字规则签，或产品管理员代「指定成员」规则签（acted_by 记实际操作人）。
 * 调用方已锁住对象、拒绝了只读 Token，并取得操作者在该产品上的角色。
 */
export async function writeSignoff(
  tx: Tx,
  actor: Actor,
  role: ProductRole,
  target: CheckTarget,
  item: CheckItem,
  input: SignInput,
): Promise<{ old: CheckState; state: CheckState; ruleIndex: number }> {
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
  const result = await ensureResult(tx, actor.orgId, target, item.key, item.defaultState);
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
  return { old: result.state, state, ruleIndex };
}
