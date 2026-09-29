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

export function signoffResultState(
  item: CheckItem,
  signoffs: Array<{ signerRuleIndex: number; decision: 'passed' | 'rejected'; at: Date }>,
): CheckState {
  if (signoffs.length === 0) return 'not_started';
  const latest = new Map<number, 'passed' | 'rejected'>();
  for (const s of [...signoffs].sort((a, b) => a.at.getTime() - b.at.getTime())) latest.set(s.signerRuleIndex, s.decision);
  const decisions = [...latest.values()];
  if (decisions.includes('rejected')) return 'rejected';
  if (item.signoffRule === 'any') return 'passed';
  const need = item.signers?.length ?? 0;
  return latest.size >= need ? 'passed' : 'in_progress';
}
