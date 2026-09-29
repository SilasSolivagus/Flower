import { describe, expect, it } from 'vitest';
import { validateWorkflowBody } from '../src/definitions/workflow-schema';

const valid = {
  states: [
    { key: 'todo', label: '待开始', color: '#60a5fa', order: 1, group: '执行', category: 'unstarted' },
    { key: 'doing', label: '进行中', color: '#f59e0b', order: 2, group: '执行', category: 'started' },
    { key: 'done', label: '已完成', color: '#10b981', order: 3, group: '执行', category: 'completed' },
  ],
  initial: 'todo',
  transitions: [
    { from: 'todo', to: 'doing', conditions: [{ type: 'check_item', item: 'design', in: ['passed', 'not_needed'] }] },
    { from: '*', to: 'done', conditions: [{ type: 'field_set', field: 'priority' }] },
  ],
  actionGates: [{ action: 'join_iteration', conditions: [{ type: 'check_item', item: 'design', in: ['passed'] }] }],
  checkItems: [
    {
      key: 'design', label: '设计签字', scope: 'document', type: 'signoff',
      signers: [{ by: 'function_tag', ref: 'tag-ui' }], signoffRule: 'all',
    },
  ],
};

const issuesOf = (body: unknown) => {
  const r = validateWorkflowBody(body, { fieldKeys: ['priority'] });
  return r.ok ? [] : r.issues.map((i) => i.message);
};

describe('validateWorkflowBody', () => {
  it('合法定义通过，并补全默认值', () => {
    const r = validateWorkflowBody(valid, { fieldKeys: ['priority'] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.body.checkItems[0]?.defaultState).toBe('not_started');
  });

  it('状态 key 重复、初始状态不存在', () => {
    const msgs = issuesOf({ ...valid, states: [...valid.states, valid.states[0]], initial: 'nope' });
    expect(msgs).toContain('状态 key「todo」重复');
    expect(msgs).toContain('初始状态「nope」不存在');
  });

  it('流转引用不存在的状态、起点终点相同、重复流转', () => {
    const msgs = issuesOf({
      ...valid,
      transitions: [
        { from: 'ghost', to: 'doing', conditions: [] },
        { from: 'doing', to: 'doing', conditions: [] },
        { from: 'todo', to: 'done', conditions: [] },
        { from: 'todo', to: 'done', conditions: [] },
      ],
    });
    expect(msgs).toContain('流转起点「ghost」不存在');
    expect(msgs).toContain('流转的起点和终点不能相同');
    expect(msgs).toContain('流转「todo->done」重复');
  });

  it('条件引用不存在的检查项或字段', () => {
    const msgs = issuesOf({
      ...valid,
      transitions: [
        { from: 'todo', to: 'doing', conditions: [{ type: 'check_item', item: 'ghost', in: ['passed'] }] },
        { from: 'doing', to: 'done', conditions: [{ type: 'field_set', field: 'nofield' }] },
      ],
    });
    expect(msgs).toContain('条件引用了不存在的检查项「ghost」');
    expect(msgs).toContain('条件引用了不存在的字段「nofield」');
  });

  it('会签检查项必须有签字人与规则，普通检查项不能有', () => {
    const msgs = issuesOf({
      ...valid,
      checkItems: [
        { key: 'design', label: '设计', scope: 'document', type: 'signoff' },
        { key: 'feas', label: '可行性', scope: 'requirement', type: 'single', signoffRule: 'all' },
      ],
    });
    expect(msgs).toContain('会签检查项必须指定签字人和会签规则');
    expect(msgs).toContain('普通检查项不能设置签字人或会签规则');
  });

  it('自动同步 PRD 状态的检查项必须作用于 PRD', () => {
    const msgs = issuesOf({
      ...valid,
      checkItems: [...valid.checkItems, { key: 'prd', label: 'PRD', scope: 'requirement', type: 'single', auto: 'prd_status' }],
    });
    expect(msgs).toContain('自动同步 PRD 状态的检查项作用范围必须是 PRD');
  });

  it('检查项条件 in 为空数组时返回中文提示', () => {
    const r = validateWorkflowBody(
      {
        ...valid,
        transitions: [{ from: 'todo', to: 'doing', conditions: [{ type: 'check_item', item: 'design', in: [] }] }],
      },
      { fieldKeys: ['priority'] },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues.some((i) => i.message === '至少选择一个检查状态')).toBe(true);
    }
  });

  it('结构错误（类别非法、颜色格式错误）返回带路径的问题', () => {
    const r = validateWorkflowBody(
      { ...valid, states: [{ ...valid.states[0], category: 'weird', color: 'red' }] },
      { fieldKeys: [] },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues.some((i) => i.path === 'states.0.category')).toBe(true);
      expect(r.issues.some((i) => i.path === 'states.0.color' && i.message === '颜色格式应为 #RRGGBB')).toBe(true);
    }
  });
});
