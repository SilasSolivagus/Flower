import { describe, expect, it } from 'vitest';
import type { Iteration, Product } from '@/lib/types';
import { commitmentRate, editableIterationProducts, filterIterationsByProduct, groupIterations, iterationFormError, iterationRowCount, iterationTab, linkCandidates, localToday, milestoneTimeline, STATUS_ACTIONS } from './model';

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

describe('迭代产品筛选', () => {
  it('选具体产品时不含专项，全部才含专项，计数等于渲染行数', () => {
    const pan = { id: 'p1', key: 'PAN', name: '网盘' };
    const list = [it0({ id: 'a', product: pan, name: '常规' }), it0({ id: 'b', type: 'special', name: '专项' })];
    const filtered = filterIterationsByProduct(list, 'p1');
    expect(filtered.map((i) => i.id)).toEqual(['a']);
    expect(iterationRowCount(groupIterations(filtered))).toBe(1);
    expect(iterationRowCount(groupIterations(filterIterationsByProduct(list, null)))).toBe(2);
  });
});

describe('迭代内可管理的产品', () => {
  const product = (over: Partial<Product>): Product => ({
    id: 'p',
    key: 'PAN',
    name: '网盘',
    status: 'active',
    workflowVersionId: null,
    structureLevelNames: null,
    myRole: 'editor',
    ...over,
  });

  it('只读成员的产品被排除', () => {
    const pan = product({ id: 'p1', myRole: 'editor' });
    const doc = product({ id: 'p2', myRole: 'viewer' });
    expect(editableIterationProducts([pan, doc], { product: null })).toEqual([pan]);
  });

  it('常规迭代（有所属产品）只保留该产品', () => {
    const pan = product({ id: 'p1', key: 'PAN' });
    const doc = product({ id: 'p2', key: 'DOC' });
    expect(editableIterationProducts([pan, doc], { product: { id: 'p1' } })).toEqual([pan]);
  });

  it('专项迭代（无所属产品）保留所有可编辑产品', () => {
    const pan = product({ id: 'p1', key: 'PAN' });
    const doc = product({ id: 'p2', key: 'DOC' });
    expect(editableIterationProducts([pan, doc], { product: null })).toEqual([pan, doc]);
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

describe('迭代详情页签', () => {
  it('地址栏的 tab 转成页签；不认识的值和未开始迭代的「范围对比」回到「需求」', () => {
    expect(iterationTab(null, true)).toBe('requirements');
    expect(iterationTab('gantt', false)).toBe('gantt');
    expect(iterationTab('releases', false)).toBe('releases');
    expect(iterationTab('scope', true)).toBe('scope');
    expect(iterationTab('scope', false)).toBe('requirements');
    expect(iterationTab('whatever', true)).toBe('requirements');
  });
});

describe('发布版本关联需求的候选', () => {
  const reqs = [
    { id: 'r1', productId: 'p1', displayKey: 'PAN-1', title: '分享链接加密码' },
    { id: 'r2', productId: 'p1', displayKey: 'PAN-2', title: '回收站恢复' },
    { id: 'r3', productId: 'p2', displayKey: 'DOC-1', title: '文档导出' },
  ];

  it('只列本迭代里同产品的需求，按编号或标题过滤，标出已关联的', () => {
    const release = { productId: 'p1', requirementIds: ['r2'] };
    expect(linkCandidates(reqs, release, '')).toEqual([
      { id: 'r1', displayKey: 'PAN-1', title: '分享链接加密码', linked: false },
      { id: 'r2', displayKey: 'PAN-2', title: '回收站恢复', linked: true },
    ]);
    expect(linkCandidates(reqs, release, 'pan-2').map((c) => c.id)).toEqual(['r2']);
    expect(linkCandidates(reqs, release, ' 分享 ').map((c) => c.id)).toEqual(['r1']);
  });
});
