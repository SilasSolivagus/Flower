import { describe, expect, it } from 'vitest';
import { primaryTransitionTo } from './transitions';

const states = [
  { key: 'backlog', order: 1, category: 'backlog' },
  { key: 'todo', order: 2, category: 'unstarted' },
  { key: 'doing', order: 3, category: 'started' },
  { key: 'done', order: 4, category: 'completed' },
  { key: 'canceled', order: 5, category: 'canceled' },
];

describe('需求状态主按钮', () => {
  it('当前之后最近的允许目标是主推荐，已取消不占主按钮', () => {
    const transitions = [
      { to: 'todo', allowed: true },
      { to: 'doing', allowed: true },
      { to: 'done', allowed: true },
      { to: 'canceled', allowed: true },
    ];
    expect(primaryTransitionTo('backlog', states, transitions)).toBe('todo');
  });

  it('最近的下一步不允许时，顺延到后面第一个允许的目标', () => {
    const transitions = [
      { to: 'todo', allowed: false },
      { to: 'doing', allowed: true },
      { to: 'canceled', allowed: true },
    ];
    expect(primaryTransitionTo('backlog', states, transitions)).toBe('doing');
  });

  it('没有向前且允许的目标时不标主按钮', () => {
    expect(
      primaryTransitionTo('done', states, [
        { to: 'backlog', allowed: true },
        { to: 'canceled', allowed: true },
      ]),
    ).toBeNull();
    expect(primaryTransitionTo('backlog', states, [{ to: 'todo', allowed: false }])).toBeNull();
    expect(primaryTransitionTo('missing', states, [{ to: 'todo', allowed: true }])).toBeNull();
  });
});
