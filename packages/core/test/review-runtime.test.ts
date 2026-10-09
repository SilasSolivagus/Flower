import { describe, expect, it } from 'vitest';
import {
  type CheckItem,
  reviewStarted,
  reviewStateOf,
  signoffProgress,
  signoffResultState,
  waitingRules,
} from '../src/requirements/workflow-runtime';

const design: CheckItem = {
  key: 'design',
  label: '设计签字',
  scope: 'requirement',
  type: 'signoff',
  signers: [
    { by: 'function_tag', ref: 'tag-ui' },
    { by: 'member', ref: 'boss' },
    { by: 'product_role', ref: 'admin' },
  ],
  signoffRule: 'all',
  defaultState: 'not_started',
};
const at = (minute: number) => new Date(Date.UTC(2026, 8, 30, 0, minute));
const who = { memberId: 'me', functionTagIds: ['tag-ui'], productRole: 'editor' as const };

describe('整体评审状态', () => {
  it('忽略不需要；任一驳回为有驳回；全部通过为已通过；全部未开始为未开始；其余为评审中', () => {
    expect(reviewStateOf(['not_started', 'not_started'])).toBe('not_started');
    expect(reviewStateOf(['passed', 'not_started'])).toBe('in_progress');
    expect(reviewStateOf(['in_progress', 'not_needed'])).toBe('in_progress');
    expect(reviewStateOf(['passed', 'rejected', 'not_started'])).toBe('rejected');
    expect(reviewStateOf(['passed', 'not_needed'])).toBe('passed');
    expect(reviewStateOf(['not_needed'])).toBe('passed');
    expect(reviewStateOf([])).toBe('passed');
  });

  it('评审是否已开始：任一需求检查项不在默认状态；PRD 类检查项不计', () => {
    const items: CheckItem[] = [
      { key: 'feasibility', label: '可行性', scope: 'requirement', type: 'single', defaultState: 'not_started' },
      { key: 'prd', label: 'PRD', scope: 'requirement', type: 'single', defaultState: 'not_needed' },
      { key: 'doc_check', label: '文档检查', scope: 'document', type: 'single', defaultState: 'not_started' },
    ];
    expect(reviewStarted(items, { feasibility: 'not_started', prd: 'not_needed', doc_check: 'passed' })).toBe(false);
    expect(reviewStarted(items, { feasibility: 'passed', prd: 'not_needed', doc_check: 'not_started' })).toBe(true);
    expect(reviewStarted(items, { feasibility: 'not_started', prd: 'not_started', doc_check: 'not_started' })).toBe(true);
    const withAuto: CheckItem[] = [...items, { key: 'prd_auto', label: 'PRD', scope: 'requirement', type: 'single', auto: 'prd_status', defaultState: 'not_started' }];
    expect(reviewStarted(withAuto, { feasibility: 'not_started', prd: 'not_needed', doc_check: 'not_started', prd_auto: 'in_progress' })).toBe(false);
  });
});

describe('会签', () => {
  it('会签进度按每条规则最近一次的结论统计通过数；结果状态的计算不变', () => {
    expect(signoffProgress(design, [])).toEqual({ passed: 0, total: 3 });
    expect(
      signoffProgress(design, [
        { signerRuleIndex: 0, decision: 'rejected', at: at(1) },
        { signerRuleIndex: 0, decision: 'passed', at: at(2) },
        { signerRuleIndex: 1, decision: 'passed', at: at(3) },
        { signerRuleIndex: 2, decision: 'rejected', at: at(4) },
      ]),
    ).toEqual({ passed: 2, total: 3 });
    expect(signoffResultState(design, [{ signerRuleIndex: 1, decision: 'passed', at: at(1) }])).toBe('in_progress');
    expect(signoffResultState(design, [{ signerRuleIndex: 1, decision: 'rejected', at: at(1) }])).toBe('rejected');
  });

  it('待签：评审已开始、检查项未开始或进行中、规则尚无签字；本人匹配的算待我签，管理员对指定成员的规则算可代签', () => {
    const ctx = { state: 'not_started' as const, signedRules: new Set<number>(), reviewStarted: true, who, canSignOnBehalf: false, assignees: new Map<string, Set<string>>() };
    expect(waitingRules(design, ctx)).toEqual([{ ruleIndex: 0, onBehalf: false }]);
    expect(waitingRules(design, { ...ctx, state: 'in_progress', who: { ...who, productRole: 'admin' }, canSignOnBehalf: true })).toEqual([
      { ruleIndex: 0, onBehalf: false },
      { ruleIndex: 1, onBehalf: true },
      { ruleIndex: 2, onBehalf: false },
    ]);
    expect(waitingRules(design, { ...ctx, signedRules: new Set([0]) })).toEqual([]);
    expect(waitingRules(design, { ...ctx, reviewStarted: false })).toEqual([]);
    expect(waitingRules(design, { ...ctx, state: 'passed' })).toEqual([]);
    expect(waitingRules(design, { ...ctx, state: 'rejected' })).toEqual([]);
    expect(waitingRules({ ...design, type: 'single', signers: undefined, signoffRule: undefined }, ctx)).toEqual([]);
    expect(waitingRules({ ...design, signers: [{ by: 'member', ref: 'me' }] }, { ...ctx, canSignOnBehalf: true })).toEqual([{ ruleIndex: 0, onBehalf: false }]);
  });

  it('该谁签字就推给谁：职能标签规则只推给以该标签分配到需求的人，没有该标签的分配时推给全部持有者；代签不受分配影响', () => {
    const ctx = { state: 'not_started' as const, signedRules: new Set<number>(), reviewStarted: true, who, canSignOnBehalf: false, assignees: new Map<string, Set<string>>() };
    expect(waitingRules(design, { ...ctx, assignees: new Map([['tag-ui', new Set(['me'])]]) })).toEqual([{ ruleIndex: 0, onBehalf: false }]);
    expect(waitingRules(design, { ...ctx, assignees: new Map([['tag-ui', new Set(['other'])]]) })).toEqual([]);
    expect(waitingRules(design, { ...ctx, assignees: new Map([['tag-dev', new Set(['other'])]]) })).toEqual([{ ruleIndex: 0, onBehalf: false }]);
    const admin = { ...ctx, who: { ...who, productRole: 'admin' as const }, canSignOnBehalf: true, assignees: new Map([['tag-ui', new Set(['other'])]]) };
    expect(waitingRules(design, admin)).toEqual([
      { ruleIndex: 1, onBehalf: true },
      { ruleIndex: 2, onBehalf: false },
    ]);
  });
});
