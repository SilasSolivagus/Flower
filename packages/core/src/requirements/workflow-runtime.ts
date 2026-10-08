import type { Condition, WorkflowBody } from '../definitions/workflow-schema';
import { CHECK_STATE_LABELS, type CheckState } from './labels';

export type CheckItem = WorkflowBody['checkItems'][number];
export type ConditionContext = {
  checks: Record<string, CheckState>;
  filledFields: Set<string>;
  hasIteration: boolean;
  hasChangeDocument: boolean;
};
export type NameLookup = { checkItem: (key: string) => string; field: (key: string) => string };
export type UnmetCondition = { condition: Condition; message: string };
export type TransitionOption = { to: string; label: string; allowed: boolean; unmet: UnmetCondition[] };
export type SignerIdentity = { memberId: string; functionTagIds: string[]; productRole: 'admin' | 'editor' | 'viewer' | null };
export type ReviewState = 'not_started' | 'in_progress' | 'rejected' | 'passed';
export type SignoffRecord = { signerRuleIndex: number; decision: 'passed' | 'rejected'; at: Date };
export type WaitingRule = { ruleIndex: number; onBehalf: boolean };

export function unmetConditions(conds: Condition[], ctx: ConditionContext, names: NameLookup): UnmetCondition[] {
  const unmet: UnmetCondition[] = [];
  for (const c of conds) {
    if (c.type === 'check_item') {
      const current = ctx.checks[c.item] ?? 'not_started';
      if (!c.in.includes(current)) {
        const want = c.in.map((s) => CHECK_STATE_LABELS[s]).join('或');
        unmet.push({ condition: c, message: `「${names.checkItem(c.item)}」需为${want}（当前：${CHECK_STATE_LABELS[current]}）` });
      }
    } else if (c.type === 'field_set') {
      if (!ctx.filledFields.has(c.field)) unmet.push({ condition: c, message: `需要填写「${names.field(c.field)}」` });
    } else if (c.type === 'has_iteration') {
      if (!ctx.hasIteration) unmet.push({ condition: c, message: '需要先加入迭代' });
    } else if (c.type === 'has_change_document') {
      if (!ctx.hasChangeDocument) unmet.push({ condition: c, message: '需要先关联变更 PRD' });
    }
  }
  return unmet;
}

export function findTransitionRule(body: WorkflowBody, from: string, to: string): WorkflowBody['transitions'][number] | null {
  if (from === to) return null;
  return body.transitions.find((t) => t.from === from && t.to === to) ?? body.transitions.find((t) => t.from === '*' && t.to === to) ?? null;
}

export function availableTransitions(body: WorkflowBody, from: string, ctx: ConditionContext, names: NameLookup): TransitionOption[] {
  const out: TransitionOption[] = [];
  for (const s of [...body.states].sort((a, b) => a.order - b.order)) {
    const rule = findTransitionRule(body, from, s.key);
    if (!rule) continue;
    const unmet = unmetConditions(rule.conditions, ctx, names);
    out.push({ to: s.key, label: rule.label || s.label, allowed: unmet.length === 0, unmet });
  }
  return out;
}

export function checkStatesFor(body: WorkflowBody, results: Array<{ itemKey: string; state: CheckState }>): Record<string, CheckState> {
  const byKey = new Map(results.map((r) => [r.itemKey, r.state]));
  return Object.fromEntries(body.checkItems.map((c) => [c.key, byKey.get(c.key) ?? c.defaultState]));
}

export function matchingSignerRules(item: CheckItem, who: SignerIdentity): number[] {
  const out: number[] = [];
  (item.signers ?? []).forEach((s, i) => {
    const ok =
      (s.by === 'member' && s.ref === who.memberId) ||
      (s.by === 'function_tag' && who.functionTagIds.includes(s.ref)) ||
      (s.by === 'product_role' && who.productRole === s.ref);
    if (ok) out.push(i);
  });
  return out;
}

/** 每条签字规则最近一次的结论。 */
function latestDecisions(signoffs: SignoffRecord[]): Map<number, 'passed' | 'rejected'> {
  const latest = new Map<number, 'passed' | 'rejected'>();
  for (const s of [...signoffs].sort((a, b) => a.at.getTime() - b.at.getTime())) latest.set(s.signerRuleIndex, s.decision);
  return latest;
}

export function signoffResultState(item: CheckItem, signoffs: SignoffRecord[]): CheckState {
  if (signoffs.length === 0) return 'not_started';
  const latest = latestDecisions(signoffs);
  const decisions = [...latest.values()];
  if (decisions.includes('rejected')) return 'rejected';
  if (item.signoffRule === 'any') return 'passed';
  const need = item.signers?.length ?? 0;
  return latest.size >= need ? 'passed' : 'in_progress';
}

/** 会签进度：最近一次结论为通过的规则数 / 规则总数。 */
export function signoffProgress(item: CheckItem, signoffs: SignoffRecord[]): { passed: number; total: number } {
  const passed = [...latestDecisions(signoffs).values()].filter((d) => d === 'passed').length;
  return { passed, total: item.signers?.length ?? 0 };
}

/**
 * 需求的整体评审状态：忽略「不需要」的检查项；任一驳回 = 有驳回；全部通过 = 已通过；
 * 全部未开始 = 未开始；其余为评审中。没有需要评审的检查项时视为已通过。
 */
export function reviewStateOf(states: CheckState[]): ReviewState {
  const relevant = states.filter((s) => s !== 'not_needed');
  if (relevant.includes('rejected')) return 'rejected';
  if (relevant.every((s) => s === 'passed')) return 'passed';
  if (relevant.every((s) => s === 'not_started')) return 'not_started';
  return 'in_progress';
}

/** 需求的评审是否已经开始：任一需求检查项不在它的默认状态。跟随 PRD 状态的 auto 项不算（挂上 PRD 不等于开始评审）。 */
export function reviewStarted(items: CheckItem[], checks: Record<string, CheckState>): boolean {
  return items.some((c) => c.scope === 'requirement' && !c.auto && checks[c.key] !== undefined && checks[c.key] !== c.defaultState);
}

/**
 * 某个会签检查项上等操作者签的规则：评审已开始、检查项未开始或进行中、规则还没有任何签字。
 * 「该谁签字就推给谁」：职能标签规则只推给以该标签分配到这条需求的成员（assignees：标签 id → 成员 id），
 * 需求上没有该标签的分配时推给全部持有者；指定成员、产品角色规则按规则本身匹配。
 * 匹配本人时为「待我签」；产品管理员对指定其他成员的规则为「可代签」，不受分配影响。
 */
export function waitingRules(
  item: CheckItem,
  ctx: {
    state: CheckState;
    signedRules: Set<number>;
    reviewStarted: boolean;
    who: SignerIdentity;
    canSignOnBehalf: boolean;
    assignees: Map<string, Set<string>>;
  },
): WaitingRule[] {
  if (item.type !== 'signoff' || !ctx.reviewStarted || (ctx.state !== 'not_started' && ctx.state !== 'in_progress')) return [];
  const mine = new Set(matchingSignerRules(item, ctx.who));
  const out: WaitingRule[] = [];
  (item.signers ?? []).forEach((s, i) => {
    if (ctx.signedRules.has(i)) return;
    const assigned = s.by === 'function_tag' ? ctx.assignees.get(s.ref) : undefined;
    const assignedToOthers = !!assigned && assigned.size > 0 && !assigned.has(ctx.who.memberId);
    if (mine.has(i) && !assignedToOthers) out.push({ ruleIndex: i, onBehalf: false });
    else if (ctx.canSignOnBehalf && s.by === 'member' && s.ref !== ctx.who.memberId) out.push({ ruleIndex: i, onBehalf: true });
  });
  return out;
}
