import { describe, expect, it } from 'vitest';
import { pickRecipients, reviewJustStarted } from '../src/member-notifications/content';
import type { CheckItem } from '../src/requirements/workflow-runtime';

describe('收件人排名', () => {
  it('每人只取排名最高的一种；操作人本人不通知', () => {
    const r = pickRecipients(
      [
        { memberId: 'a', kind: 'followed_change', body: '关注' },
        { memberId: 'a', kind: 'mentioned', body: '被 @' },
        { memberId: 'a', kind: 'assigned', body: '指派' },
        { memberId: 'b', kind: 'signoff_due', body: '签字' },
        { memberId: 'b', kind: 'followed_change', body: '关注' },
        { memberId: 'me', kind: 'mentioned', body: '自己' },
      ],
      'me',
    );
    expect([...r.values()]).toEqual([
      { memberId: 'a', kind: 'mentioned', body: '被 @' },
      { memberId: 'b', kind: 'signoff_due', body: '签字' },
    ]);
  });

  it('同一种以先出现的说明为准；没有操作人时都保留', () => {
    const r = pickRecipients(
      [
        { memberId: 'a', kind: 'assigned', body: '把你设为需求负责人' },
        { memberId: 'a', kind: 'assigned', body: '把你分配为「设计」' },
      ],
      null,
    );
    expect(r.get('a')!.body).toBe('把你设为需求负责人');
  });
});

describe('评审是否由这次变化开始', () => {
  const items = [
    { key: 'feasibility', label: '可行性', scope: 'requirement', type: 'single', defaultState: 'not_started' },
    { key: 'prd', label: 'PRD', scope: 'requirement', type: 'single', auto: 'prd_status', defaultState: 'not_started' },
  ] as CheckItem[];

  it('第一次离开默认状态才算；之后的变化与 auto 项不算', () => {
    expect(reviewJustStarted(items, { feasibility: 'in_progress', prd: 'not_started' }, 'feasibility', 'not_started')).toBe(true);
    expect(reviewJustStarted(items, { feasibility: 'passed', prd: 'not_started' }, 'feasibility', 'in_progress')).toBe(false);
    expect(reviewJustStarted(items, { feasibility: 'not_started', prd: 'passed' }, 'prd', 'not_started')).toBe(false);
  });
});
