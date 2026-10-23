import { describe, expect, it } from 'vitest';
import { primaryStatusAction, transitionDisabledReason } from './status-menu';

const todo = {
  to: 'todo',
  label: '待开发',
  allowed: false,
  unmet: [{ message: '「可行性」需为通过（当前：未开始）' }],
};
const doing = {
  to: 'doing',
  label: '开发中',
  allowed: true,
  unmet: [] as { message: string }[],
};

describe('状态菜单', () => {
  it('未满足条件收成菜单副文案，不另起常驻列表', () => {
    expect(transitionDisabledReason(todo, true)).toBe('「可行性」需为通过（当前：未开始）');
    expect(transitionDisabledReason({ ...doing, allowed: false, unmet: [{ message: '需要先加入迭代' }, { message: '需要先关联变更 PRD' }] }, true)).toBe(
      '需要先加入迭代；需要先关联变更 PRD',
    );
    expect(transitionDisabledReason({ ...doing, allowed: false, unmet: [] }, true)).toBe('现在不能改到这个状态');
    expect(transitionDisabledReason(doing, true)).toBeUndefined();
  });

  it('查看者的短因是不能改状态，不把条件铺在按钮下', () => {
    expect(transitionDisabledReason(doing, false)).toBe('只有编辑可以改状态');
    expect(transitionDisabledReason(todo, false)).toBe('只有编辑可以改状态');
  });

  it('主操作最多一个，且只在可编辑、目标允许时出现', () => {
    expect(primaryStatusAction(true, 'doing', [todo, doing])).toEqual(doing);
    expect(primaryStatusAction(true, 'todo', [todo, doing])).toBeNull();
    expect(primaryStatusAction(false, 'doing', [todo, doing])).toBeNull();
    expect(primaryStatusAction(true, null, [todo, doing])).toBeNull();
  });
});
