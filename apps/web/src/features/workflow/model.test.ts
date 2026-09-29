import { describe, expect, it } from 'vitest';
import type { WorkflowBody } from '@/lib/types';
import {
  ANY,
  addCheckItem,
  addState,
  getConditions,
  getGateConditions,
  layoutGraph,
  newKey,
  removeCheckItem,
  removeState,
  reorderStates,
  setConditions,
  setGateConditions,
  toggleTransition,
  transitionMode,
} from './model';

const body: WorkflowBody = {
  states: [
    { key: 'todo', label: '待开始', color: '#2f6fd6', order: 1, group: '执行', category: 'unstarted' },
    { key: 'doing', label: '进行中', color: '#b7791f', order: 2, group: '执行', category: 'started' },
    { key: 'done', label: '已完成', color: '#1e8a5a', order: 3, group: '执行', category: 'completed' },
    { key: 'hold', label: '已搁置', color: '#5c6570', order: 4, group: '收尾', category: 'canceled' },
  ],
  initial: 'todo',
  transitions: [
    { from: 'todo', to: 'doing', conditions: [] },
    { from: ANY, to: 'hold', conditions: [] },
  ],
  actionGates: [],
  checkItems: [{ key: 'design', label: '设计签字', scope: 'document', type: 'single', defaultState: 'not_started' }],
};

describe('流转', () => {
  it('区分显式、由"任意状态"推出、不允许', () => {
    expect(transitionMode(body, 'todo', 'doing')).toBe('explicit');
    expect(transitionMode(body, 'doing', 'hold')).toBe('implied');
    expect(transitionMode(body, ANY, 'hold')).toBe('explicit');
    expect(transitionMode(body, 'doing', 'todo')).toBe('none');
    expect(transitionMode(body, 'todo', 'todo')).toBe('none');
  });

  it('切换显式流转，不修改原对象', () => {
    const b1 = toggleTransition(body, 'doing', 'done');
    expect(transitionMode(b1, 'doing', 'done')).toBe('explicit');
    expect(transitionMode(body, 'doing', 'done')).toBe('none');
    expect(transitionMode(toggleTransition(b1, 'doing', 'done'), 'doing', 'done')).toBe('none');
  });

  it('读写流转条件', () => {
    const b = setConditions(body, 'todo', 'doing', [{ type: 'check_item', item: 'design', in: ['passed'] }]);
    expect(getConditions(b, 'todo', 'doing')).toEqual([{ type: 'check_item', item: 'design', in: ['passed'] }]);
    expect(getConditions(body, 'todo', 'doing')).toEqual([]);
  });
});

describe('状态', () => {
  it('新增状态生成不冲突的 key 与递增的顺序', () => {
    expect(newKey('s', ['s_1', 's_2'])).toBe('s_3');
    expect(newKey('s', ['s_2'])).toBe('s_1');
    const b = addState(body, { label: '测试中', category: 'started', group: '执行' });
    const added = b.states.at(-1)!;
    expect(added).toMatchObject({ key: 's_1', label: '测试中', order: 5, color: '#b7791f' });
  });

  it('删除状态时删掉相关流转，删掉初始状态时改用第一个剩下的状态', () => {
    const b = removeState(body, 'todo');
    expect(b.states.map((s) => s.key)).toEqual(['doing', 'done', 'hold']);
    expect(b.transitions).toEqual([{ from: ANY, to: 'hold', conditions: [] }]);
    expect(b.initial).toBe('doing');
  });

  it('重新排序时同时更新 order', () => {
    const b = reorderStates(body, ['done', 'todo', 'doing', 'hold']);
    expect(b.states.map((s) => [s.key, s.order])).toEqual([
      ['done', 1],
      ['todo', 2],
      ['doing', 3],
      ['hold', 4],
    ]);
  });
});

describe('检查项与门禁', () => {
  it('删除检查项时删掉引用它的条件', () => {
    let b = setConditions(body, 'todo', 'doing', [{ type: 'check_item', item: 'design', in: ['passed'] }, { type: 'has_iteration' }]);
    b = setGateConditions(b, [{ type: 'check_item', item: 'design', in: ['passed'] }]);
    b = removeCheckItem(b, 'design');
    expect(getConditions(b, 'todo', 'doing')).toEqual([{ type: 'has_iteration' }]);
    expect(getGateConditions(b)).toEqual([]);
    expect(b.actionGates).toEqual([]);
  });

  it('新增检查项带默认状态', () => {
    const b = addCheckItem(body, { label: '可行性', scope: 'requirement', type: 'single' });
    expect(b.checkItems.at(-1)).toEqual({ key: 'c_1', label: '可行性', scope: 'requirement', type: 'single', defaultState: 'not_started' });
  });
});

describe('状态图布局', () => {
  it('按分组分行，"任意状态"单独一个节点，条件与选中状态体现在边上', () => {
    const b = setConditions(body, 'todo', 'doing', [{ type: 'has_iteration' }]);
    const g = layoutGraph(b, { from: 'todo', to: 'doing' });
    expect(g.nodes.map((n) => n.id)).toEqual(['__any', 'todo', 'doing', 'done', 'hold']);
    const todo = g.nodes.find((n) => n.id === 'todo')!;
    const hold = g.nodes.find((n) => n.id === 'hold')!;
    expect(hold.y).toBeGreaterThan(todo.y);
    expect(g.edges).toEqual([
      { id: 'todo->doing', source: 'todo', target: 'doing', from: 'todo', to: 'doing', conditional: true, selected: true },
      { id: '*->hold', source: '__any', target: 'hold', from: '*', to: 'hold', conditional: false, selected: false },
    ]);
  });
});
