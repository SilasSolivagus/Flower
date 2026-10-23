import { describe, expect, it } from 'vitest';
import { primaryTransitionTo, statusMenuEntries } from './transitions';

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

describe('状态菜单', () => {
  it('合法下一态可点，非法的留在菜单里并带短因', () => {
    const entries = statusMenuEntries(
      [
        { to: 'todo', label: '待开发', allowed: false, unmet: [{ message: '「可行性」需为通过（当前：未开始）' }] },
        { to: 'doing', label: '开发中', allowed: true, unmet: [] },
      ],
      true,
    );
    expect(entries).toEqual([
      { to: 'todo', label: '待开发', enabled: false, reason: '「可行性」需为通过（当前：未开始）' },
      { to: 'doing', label: '开发中', enabled: true },
    ]);
  });

  it('查看者看到的合法流转也停用，并说明只有编辑可以改', () => {
    expect(statusMenuEntries([{ to: 'todo', label: '待开始', allowed: true, unmet: [] }], false)).toEqual([
      { to: 'todo', label: '待开始', enabled: false, reason: '只有编辑可以改状态' },
    ]);
  });

  it('没有条件说明时用一句兜底', () => {
    expect(statusMenuEntries([{ to: 'done', label: '已完成', allowed: false, unmet: [] }], true)[0]?.reason).toBe('现在不能改到这个状态');
  });
});
