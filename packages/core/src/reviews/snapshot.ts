import { and, asc, eq, inArray } from 'drizzle-orm';
import { checkItemResults, checkItemSignoffs, memberFunctionTags, requirementAssignments } from '../db/schema';
import type { Tx } from '../db/tx';
import type { WorkflowBody } from '../definitions/workflow-schema';
import type { Actor, ProductRole } from '../domain-types';
import type { CheckState } from '../requirements/labels';
import {
  type CheckItem,
  checkStatesFor,
  reviewStarted,
  type SignerIdentity,
  type SignoffRecord,
  waitingRules,
  type WaitingRule,
} from '../requirements/workflow-runtime';

export type CheckSnapshot = {
  states: Record<string, CheckState>;
  signoffs: Map<string, SignoffRecord[]>;
  /** 职能标签 id → 以该标签分配到这条需求的成员 id（requirement_assignments 中带职能标签的行）。 */
  assignees: Map<string, Set<string>>;
};

/** 一批需求的检查项状态（缺省按流程默认状态）、会签记录（按检查项分组、按时间排序）与按职能标签的分配。 */
export async function checkSnapshots(tx: Tx, body: WorkflowBody, requirementIds: string[]): Promise<Map<string, CheckSnapshot>> {
  const results = requirementIds.length
    ? await tx
        .select({ id: checkItemResults.id, targetId: checkItemResults.targetId, itemKey: checkItemResults.itemKey, state: checkItemResults.state })
        .from(checkItemResults)
        .where(and(eq(checkItemResults.targetType, 'requirement'), inArray(checkItemResults.targetId, requirementIds)))
    : [];
  const signoffs = results.length
    ? await tx
        .select({
          resultId: checkItemSignoffs.resultId,
          signerRuleIndex: checkItemSignoffs.signerRuleIndex,
          decision: checkItemSignoffs.decision,
          at: checkItemSignoffs.at,
        })
        .from(checkItemSignoffs)
        .where(inArray(checkItemSignoffs.resultId, results.map((r) => r.id)))
        .orderBy(asc(checkItemSignoffs.at), asc(checkItemSignoffs.id))
    : [];
  const byResult = new Map<string, SignoffRecord[]>();
  for (const s of signoffs) {
    const list = byResult.get(s.resultId) ?? [];
    list.push({ signerRuleIndex: s.signerRuleIndex, decision: s.decision, at: s.at });
    byResult.set(s.resultId, list);
  }
  const assignmentRows = requirementIds.length
    ? await tx
        .select({ requirementId: requirementAssignments.requirementId, memberId: requirementAssignments.memberId, tagId: requirementAssignments.functionTagId })
        .from(requirementAssignments)
        .where(inArray(requirementAssignments.requirementId, requirementIds))
    : [];
  const assigneesByRequirement = new Map<string, Map<string, Set<string>>>();
  for (const a of assignmentRows) {
    if (!a.tagId) continue;
    const byTag = assigneesByRequirement.get(a.requirementId) ?? new Map<string, Set<string>>();
    const members = byTag.get(a.tagId) ?? new Set<string>();
    members.add(a.memberId);
    byTag.set(a.tagId, members);
    assigneesByRequirement.set(a.requirementId, byTag);
  }
  const byRequirement = new Map<string, typeof results>();
  for (const r of results) {
    const list = byRequirement.get(r.targetId) ?? [];
    list.push(r);
    byRequirement.set(r.targetId, list);
  }
  const out = new Map<string, CheckSnapshot>();
  for (const id of requirementIds) {
    const mine = byRequirement.get(id) ?? [];
    out.set(id, {
      states: checkStatesFor(body, mine.map((r) => ({ itemKey: r.itemKey, state: r.state }))),
      signoffs: new Map(mine.map((r) => [r.itemKey, byResult.get(r.id) ?? []])),
      assignees: assigneesByRequirement.get(id) ?? new Map(),
    });
  }
  return out;
}

/** 操作者作为签字人的身份：成员本人、职能标签、在该产品上的角色。 */
export async function signerIdentity(tx: Tx, actor: Actor, role: ProductRole): Promise<SignerIdentity> {
  const tags = await tx.select({ tagId: memberFunctionTags.tagId }).from(memberFunctionTags).where(eq(memberFunctionTags.memberId, actor.memberId));
  return { memberId: actor.memberId, functionTagIds: tags.map((x) => x.tagId), productRole: role };
}

export type ItemWaiting = WaitingRule & { itemKey: string };

/**
 * 一条需求上，操作者等待处理的全部会签规则：按需求检查项逐个装配 waitingRules 需要的上下文
 * （检查项状态、已签规则、评审是否已开始、按职能标签的分配）并调用它。评审队列（Task 5）与
 * 工作台（Task 6）按需求调用同一个函数，不各自重新拼装上下文。
 */
export function waitingFor(items: CheckItem[], snap: CheckSnapshot, who: SignerIdentity, canSignOnBehalf: boolean): ItemWaiting[] {
  const started = reviewStarted(items, snap.states);
  const out: ItemWaiting[] = [];
  for (const item of items) {
    const state = snap.states[item.key];
    if (state === undefined) continue;
    const signoffs = snap.signoffs.get(item.key) ?? [];
    const rules = waitingRules(item, {
      state,
      signedRules: new Set(signoffs.map((s) => s.signerRuleIndex)),
      reviewStarted: started,
      who,
      canSignOnBehalf,
      assignees: snap.assignees,
    });
    for (const w of rules) out.push({ itemKey: item.key, ...w });
  }
  return out;
}
