import { describe, expect, it } from 'vitest';
import type { WorkflowBody } from '../src/definitions/workflow-schema';
import {
  availableTransitions,
  checkStatesFor,
  type ConditionContext,
  findTransitionRule,
  matchingSignerRules,
  signoffResultState,
  unmetConditions,
} from '../src/requirements/workflow-runtime';

const names = { checkItem: (k: string) => ({ feasibility: '可行性', design: '设计签字' })[k] ?? k, field: (k: string) => ({ priority: '优先级' })[k] ?? k };

const body: WorkflowBody = {
  states: [
    { key: 'collect', label: '收集', color: '#94a3b8', order: 1, group: '分析', category: 'backlog' },
    { key: 'to_design', label: '待设计', color: '#60a5fa', order: 2, group: '开发', category: 'unstarted' },
    { key: 'developing', label: '开发中', color: '#f97316', order: 3, group: '开发', category: 'started' },
    { key: 'shelved', label: '已搁置', color: '#6b7280', order: 4, group: '', category: 'canceled' },
  ],
  initial: 'collect',
  transitions: [
    { from: '*', to: 'to_design', conditions: [{ type: 'check_item', item: 'feasibility', in: ['passed', 'not_needed'] }] },
    { from: 'collect', to: 'to_design', label: '直接进入设计', conditions: [{ type: 'field_set', field: 'priority' }] },
    { from: '*', to: 'developing', conditions: [{ type: 'has_iteration' }] },
    { from: '*', to: 'shelved', conditions: [] },
  ],
  actionGates: [],
  checkItems: [
    { key: 'feasibility', label: '可行性', scope: 'requirement', type: 'single', defaultState: 'not_started' },
    {
      key: 'design',
      label: '设计签字',
      scope: 'requirement',
      type: 'signoff',
      signers: [
        { by: 'function_tag', ref: 'tag-ui' },
        { by: 'member', ref: 'm-boss' },
      ],
      signoffRule: 'all',
      defaultState: 'not_started',
    },
  ],
};

const ctx = (over: Partial<ConditionContext> = {}): ConditionContext => ({
  checks: { feasibility: 'not_started', design: 'not_started' },
  filledFields: new Set(),
  hasIteration: false,
  hasChangeDocument: false,
  ...over,
});

describe('unmetConditions', () => {
  it('逐条给出未满足的原因', () => {
    const unmet = unmetConditions(
      [
        { type: 'check_item', item: 'feasibility', in: ['passed', 'not_needed'] },
        { type: 'field_set', field: 'priority' },
        { type: 'has_iteration' },
        { type: 'has_change_document' },
      ],
      ctx(),
      names,
    );
    expect(unmet.map((u) => u.message)).toEqual([
      '「可行性」需为通过或不需要（当前：未开始）',
      '需要填写「优先级」',
      '需要先加入迭代',
      '需要先关联变更 PRD',
    ]);
  });

  it('条件都满足时返回空数组', () => {
    const c = ctx({ checks: { feasibility: 'passed' }, filledFields: new Set(['priority']), hasIteration: true, hasChangeDocument: true });
    expect(
      unmetConditions([{ type: 'check_item', item: 'feasibility', in: ['passed'] }, { type: 'field_set', field: 'priority' }, { type: 'has_iteration' }], c, names),
    ).toEqual([]);
  });
});

describe('availableTransitions', () => {
  it('显式规则优先于任意状态规则，排除当前状态，按状态顺序排列', () => {
    const opts = availableTransitions(body, 'collect', ctx(), names);
    expect(opts.map((o) => o.to)).toEqual(['to_design', 'developing', 'shelved']);
    const toDesign = opts[0]!;
    expect(toDesign.label).toBe('直接进入设计');
    expect(toDesign.allowed).toBe(false);
    expect(toDesign.unmet.map((u) => u.message)).toEqual(['需要填写「优先级」']);
  });

  it('没有显式规则时使用任意状态规则', () => {
    const opts = availableTransitions(body, 'developing', ctx({ checks: { feasibility: 'passed' } }), names);
    expect(opts.find((o) => o.to === 'to_design')).toMatchObject({ label: '待设计', allowed: true, unmet: [] });
  });

  it('没有任何规则的目标不出现', () => {
    const noShelve = { ...body, transitions: body.transitions.filter((t) => t.to !== 'shelved') };
    expect(availableTransitions(noShelve, 'collect', ctx(), names).map((o) => o.to)).not.toContain('shelved');
  });

  it('findTransitionRule 返回生效的规则', () => {
    expect(findTransitionRule(body, 'collect', 'to_design')?.label).toBe('直接进入设计');
    expect(findTransitionRule(body, 'developing', 'to_design')?.from).toBe('*');
    expect(findTransitionRule(body, 'collect', 'collect')).toBeNull();
  });
});

describe('checkStatesFor', () => {
  it('没有结果的检查项取默认状态', () => {
    expect(checkStatesFor(body, [{ itemKey: 'feasibility', state: 'passed' }])).toEqual({ feasibility: 'passed', design: 'not_started' });
  });
});

describe('会签', () => {
  const design = body.checkItems[1]!;

  it('按职能标签、指定成员、产品角色匹配签字规则', () => {
    expect(matchingSignerRules(design, { memberId: 'm-1', functionTagIds: ['tag-ui'], productRole: 'editor' })).toEqual([0]);
    expect(matchingSignerRules(design, { memberId: 'm-boss', functionTagIds: [], productRole: 'viewer' })).toEqual([1]);
    expect(matchingSignerRules(design, { memberId: 'm-2', functionTagIds: [], productRole: 'admin' })).toEqual([]);
    const byRole = { ...design, signers: [{ by: 'product_role' as const, ref: 'admin' }] };
    expect(matchingSignerRules(byRole, { memberId: 'm-2', functionTagIds: [], productRole: 'admin' })).toEqual([0]);
  });

  it('all 规则：全部签字规则最新一次都通过才算通过', () => {
    const t1 = new Date('2026-07-01T00:00:00Z');
    const t2 = new Date('2026-07-02T00:00:00Z');
    expect(signoffResultState(design, [])).toBe('not_started');
    expect(signoffResultState(design, [{ signerRuleIndex: 0, decision: 'passed', at: t1 }])).toBe('in_progress');
    expect(
      signoffResultState(design, [
        { signerRuleIndex: 0, decision: 'passed', at: t1 },
        { signerRuleIndex: 1, decision: 'passed', at: t1 },
      ]),
    ).toBe('passed');
    expect(
      signoffResultState(design, [
        { signerRuleIndex: 0, decision: 'rejected', at: t1 },
        { signerRuleIndex: 0, decision: 'passed', at: t2 },
        { signerRuleIndex: 1, decision: 'passed', at: t1 },
      ]),
    ).toBe('passed');
    expect(signoffResultState(design, [{ signerRuleIndex: 1, decision: 'rejected', at: t1 }])).toBe('rejected');
  });

  it('any 规则：任一签字规则通过即通过', () => {
    const any = { ...design, signoffRule: 'any' as const };
    expect(signoffResultState(any, [{ signerRuleIndex: 1, decision: 'passed', at: new Date() }])).toBe('passed');
  });
});
