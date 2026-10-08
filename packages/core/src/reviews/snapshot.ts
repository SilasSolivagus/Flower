import { and, asc, eq, inArray } from 'drizzle-orm';
import { checkItemResults, checkItemSignoffs, memberFunctionTags, members, requirementAssignments } from '../db/schema';
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
  /** 职能标签 id → 以该标签分配到这条需求的成员 id（requirement_assignments 中带职能标签的行）。PRD 上没有分配，恒为空。 */
  assignees: Map<string, Set<string>>;
};

/** 一批对象的检查项结果（按对象分组）与会签记录（按结果分组、按时间排序）。 */
async function loadResults(tx: Tx, targetType: 'requirement' | 'document', ids: string[]) {
  const results = ids.length
    ? await tx
        .select({ id: checkItemResults.id, targetId: checkItemResults.targetId, itemKey: checkItemResults.itemKey, state: checkItemResults.state })
        .from(checkItemResults)
        .where(and(eq(checkItemResults.targetType, targetType), inArray(checkItemResults.targetId, ids)))
    : [];
  const signoffs = results.length
    ? await tx
        .select({ resultId: checkItemSignoffs.resultId, signerRuleIndex: checkItemSignoffs.signerRuleIndex, decision: checkItemSignoffs.decision, at: checkItemSignoffs.at })
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
  const byTarget = new Map<string, typeof results>();
  for (const r of results) {
    const list = byTarget.get(r.targetId) ?? [];
    list.push(r);
    byTarget.set(r.targetId, list);
  }
  return (body: WorkflowBody, id: string, assignees: Map<string, Set<string>>): CheckSnapshot => {
    const mine = byTarget.get(id) ?? [];
    return {
      states: checkStatesFor(body, mine.map((r) => ({ itemKey: r.itemKey, state: r.state }))),
      signoffs: new Map(mine.map((r) => [r.itemKey, byResult.get(r.id) ?? []])),
      assignees,
    };
  };
}

/** 一批需求的检查项状态（缺省按流程默认状态）、会签记录（按检查项分组、按时间排序）与按职能标签的分配。 */
export async function checkSnapshots(tx: Tx, body: WorkflowBody, requirementIds: string[]): Promise<Map<string, CheckSnapshot>> {
  const snapshotOf = await loadResults(tx, 'requirement', requirementIds);
  // 只把在职、且当前持有该标签的被分配人计入 assignees；否则 waitingRules 视同没有有效分配，回退为推给全部持有者。
  const assignmentRows = requirementIds.length
    ? await tx
        .select({ requirementId: requirementAssignments.requirementId, memberId: requirementAssignments.memberId, tagId: requirementAssignments.functionTagId })
        .from(requirementAssignments)
        .innerJoin(members, eq(members.id, requirementAssignments.memberId))
        .innerJoin(
          memberFunctionTags,
          and(eq(memberFunctionTags.memberId, requirementAssignments.memberId), eq(memberFunctionTags.tagId, requirementAssignments.functionTagId)),
        )
        .where(and(inArray(requirementAssignments.requirementId, requirementIds), eq(members.status, 'active')))
    : [];
  const assigneesByRequirement = new Map<string, Map<string, Set<string>>>();
  for (const a of assignmentRows) {
    if (!a.tagId) continue;
    const byTag = assigneesByRequirement.get(a.requirementId) ?? new Map<string, Set<string>>();
    const set = byTag.get(a.tagId) ?? new Set<string>();
    set.add(a.memberId);
    byTag.set(a.tagId, set);
    assigneesByRequirement.set(a.requirementId, byTag);
  }
  return new Map(requirementIds.map((id) => [id, snapshotOf(body, id, assigneesByRequirement.get(id) ?? new Map())]));
}

/** 一批 PRD 的检查项状态与会签记录。 */
export async function documentSnapshots(tx: Tx, body: WorkflowBody, documentIds: string[]): Promise<Map<string, CheckSnapshot>> {
  const snapshotOf = await loadResults(tx, 'document', documentIds);
  return new Map(documentIds.map((id) => [id, snapshotOf(body, id, new Map())]));
}

/** 操作者作为签字人的身份：成员本人、职能标签、在该产品上的角色。 */
export async function signerIdentity(tx: Tx, actor: Actor, role: ProductRole): Promise<SignerIdentity> {
  const tags = await tx.select({ tagId: memberFunctionTags.tagId }).from(memberFunctionTags).where(eq(memberFunctionTags.memberId, actor.memberId));
  return { memberId: actor.memberId, functionTagIds: tags.map((x) => x.tagId), productRole: role };
}

export type ItemWaiting = WaitingRule & { itemKey: string };

/**
 * 一个对象上操作者等待处理的全部会签规则：按检查项逐个装配 waitingRules 需要的上下文并调用它。
 * 评审是否已开始：需求按 reviewStarted 判断；PRD 由调用方传入 started（处于评审中）。
 */
export function waitingFor(items: CheckItem[], snap: CheckSnapshot, who: SignerIdentity, canSignOnBehalf: boolean, started?: boolean): ItemWaiting[] {
  const begun = started ?? reviewStarted(items, snap.states);
  const out: ItemWaiting[] = [];
  for (const item of items) {
    const state = snap.states[item.key];
    if (state === undefined) continue;
    const signoffs = snap.signoffs.get(item.key) ?? [];
    const rules = waitingRules(item, {
      state,
      signedRules: new Set(signoffs.map((s) => s.signerRuleIndex)),
      reviewStarted: begun,
      who,
      canSignOnBehalf,
      assignees: snap.assignees,
    });
    for (const w of rules) out.push({ itemKey: item.key, ...w });
  }
  return out;
}
