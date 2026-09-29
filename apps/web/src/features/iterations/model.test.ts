import { describe, expect, it } from 'vitest';
import type { Iteration } from '@/lib/types';
import { commitmentRate, groupIterations, iterationFormError, localToday, milestoneTimeline, STATUS_ACTIONS } from './model';

const it0 = (over: Partial<Iteration>): Iteration => ({
  id: 'i',
  type: 'regular',
  product: null,
  name: '迭代',
  startDate: '2026-07-01',
  endDate: '2026-07-14',
  baselineEndDate: null,
  status: 'planning',
  milestones: [],
  requirementCount: 0,
  doneCount: 0,
  canManage: false,
  ...over,
});

describe('迭代列表模型', () => {
  it('按产品分组，产品按编号前缀排序，专项放最后，组内保持原顺序', () => {
    const doc = { id: 'p2', key: 'DOC', name: '文档' };
    const pan = { id: 'p1', key: 'PAN', name: '网盘' };
    const groups = groupIterations([
      it0({ id: 'a', type: 'special', name: '专项一' }),
      it0({ id: 'b', product: pan, name: '迭代0801' }),
      it0({ id: 'c', product: doc, name: '文档迭代' }),
      it0({ id: 'd', product: pan, name: '迭代0701' }),
    ]);
    expect(groups.map((g) => [g.title, g.iterations.map((i) => i.id)])).toEqual([
      ['文档', ['c']],
      ['网盘', ['b', 'd']],
      ['专项', ['a']],
    ]);
  });

  it('里程碑按日期排序并标记是否已过', () => {
    expect(
      milestoneTimeline(
        [
          { label: '发布', date: '2026-07-15' },
          { label: '开发开始', date: '2026-07-03' },
        ],
        '2026-07-10',
      ),
    ).toEqual([
      { label: '开发开始', date: '2026-07-03', past: true },
      { label: '发布', date: '2026-07-15', past: false },
    ]);
  });

  it('本地日期格式', () => {
    expect(localToday(new Date(2026, 6, 5, 23, 30))).toBe('2026-07-05');
  });

  it('表单校验给出第一条错误', () => {
    const ok = { name: '迭代0701', startDate: '2026-07-01', endDate: '2026-07-14', milestones: [] };
    expect(iterationFormError(ok)).toBeNull();
    expect(iterationFormError({ ...ok, name: ' ' })).toBe('请填写迭代名称');
    expect(iterationFormError({ ...ok, endDate: '' })).toBe('请填写开始和结束日期');
    expect(iterationFormError({ ...ok, endDate: '2026-06-30' })).toBe('结束日期不能早于开始日期');
    expect(iterationFormError({ ...ok, milestones: [{ label: '发布', date: '' }] })).toBe('里程碑需要填写名称和日期');
  });
});

describe('迭代状态操作与承诺完成率', () => {
  it('只有规划中和进行中有状态操作', () => {
    expect(STATUS_ACTIONS.planning.map((a) => [a.to, a.label])).toEqual([
      ['active', '开始迭代'],
      ['canceled', '取消迭代'],
    ]);
    expect(STATUS_ACTIONS.active.map((a) => a.to)).toEqual(['done', 'canceled']);
    expect(STATUS_ACTIONS.done).toEqual([]);
    expect(STATUS_ACTIONS.canceled).toEqual([]);
  });

  it('承诺完成率 = 承诺内已完成 / 承诺总数（含中途移出）', () => {
    expect(commitmentRate({ committedDone: [1, 2], committedOpen: [3], removed: [4] })).toBe(50);
    expect(commitmentRate({ committedDone: [1], committedOpen: [2, 3], removed: [] })).toBe(33);
    expect(commitmentRate({ committedDone: [], committedOpen: [], removed: [] })).toBeNull();
  });
});
