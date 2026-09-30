import { describe, expect, it } from 'vitest';
import { cellText, DEFAULT_REVIEW_FILTER, reviewQuery, waitingText } from './model';

describe('评审表', () => {
  it('查询参数：整体状态必带；选了检查项才带检查项状态；等我签字', () => {
    expect(reviewQuery(DEFAULT_REVIEW_FILTER)).toBe('state=open');
    expect(reviewQuery({ ...DEFAULT_REVIEW_FILTER, state: 'all', itemKey: 'design', itemState: 'in_progress', mine: true })).toBe(
      'state=all&item=design&itemState=in_progress&mine=1',
    );
  });

  it('单元格：普通检查项只显示状态，会签检查项加上通过数', () => {
    expect(cellText({ state: 'passed', passed: null, total: null })).toBe('通过');
    expect(cellText({ state: 'in_progress', passed: 1, total: 2 })).toBe('进行中 1/2');
  });

  it('待签标记：有本人的规则为「待我签」，只有代签时为「可代签」', () => {
    expect(waitingText([])).toBeNull();
    expect(waitingText([{ itemKey: 'design', ruleIndex: 1, onBehalf: true }])).toBe('可代签');
    expect(
      waitingText([
        { itemKey: 'design', ruleIndex: 1, onBehalf: true },
        { itemKey: 'design', ruleIndex: 0, onBehalf: false },
      ]),
    ).toBe('待我签');
  });
});
