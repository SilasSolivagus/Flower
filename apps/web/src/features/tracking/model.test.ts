import { describe, expect, it } from 'vitest';
import type { TrackingItem, TrackingList } from '@/lib/types';
import { agingRows, boardColumns, DEFAULT_FILTER, expectedDateView, filterFromParams, filterQuery, hasFilter, itemHref, ownerGroups, staleRows, targetOf, trackingFilterSummary, trackingHref } from './model';

const item = (over: Partial<TrackingItem>): TrackingItem => ({
  kind: 'requirement',
  id: 'r1',
  displayKey: 'PAN-1',
  title: '需求',
  product: { id: 'p1', key: 'PAN', name: '网盘' },
  owner: null,
  type: null,
  priority: null,
  stage: { key: 'dev', label: '开发中', color: '#f59e0b', category: 'started' },
  paused: null,
  stageDays: 0,
  wipDays: 0,
  aging: 'normal',
  stale: false,
  startedOn: '2026-10-01',
  stageEnteredOn: '2026-10-01',
  blockers: { count: 0, first: null },
  latest: null,
  expectedDate: null,
  doneOn: null,
  done: false,
  canWrite: true,
  canEditDate: true,
  ...over,
});

const STATES = [
  { key: 'collect', label: '收集', color: '#94a3b8', category: 'backlog', order: 1 },
  { key: 'design', label: '设计中', color: '#60a5fa', category: 'unstarted', order: 2 },
  { key: 'dev', label: '开发中', color: '#f59e0b', category: 'started', order: 3 },
  { key: 'done', label: '已上线', color: '#10b981', category: 'completed', order: 4 },
];
const list = (items: TrackingItem[]): Pick<TrackingList, 'products' | 'items'> => ({ products: [{ id: 'p1', key: 'PAN', name: '网盘', states: STATES }], items });

describe('地址栏解析', () => {
  it('不认识的页签当作「全部在手」；布尔筛选只认 1；其余值原样带给接口', () => {
    expect(filterFromParams(new URLSearchParams('tab=nope&product=abc&paused=1&blocked=true'))).toEqual({ ...DEFAULT_FILTER, product: 'abc', paused: true });
    expect(filterFromParams(new URLSearchParams('tab=board&owner=m1&type=t1&done=1'))).toEqual({
      tab: 'board',
      product: null,
      owner: 'm1',
      type: 't1',
      paused: false,
      blocked: false,
      done: true,
    });
  });

  it('接口查询串不含页签；页面地址在非默认页签时带 tab；页签不算筛选', () => {
    const f = { ...DEFAULT_FILTER, tab: 'aging' as const, product: 'p1', blocked: true };
    expect(filterQuery(f)).toBe('product=p1&blocked=1');
    expect(trackingHref('acme', f)).toBe('/acme/tracking?product=p1&blocked=1&tab=aging');
    expect(trackingHref('acme', DEFAULT_FILTER)).toBe('/acme/tracking');
    expect(hasFilter(DEFAULT_FILTER)).toBe(false);
    expect(hasFilter({ ...DEFAULT_FILTER, tab: 'board' })).toBe(false);
    expect(hasFilter(f)).toBe(true);
  });

  it('空筛说明点明产品、负责人和开关', () => {
    const names = { products: [{ id: 'p1', name: '网盘' }], owners: [{ id: 'm1', displayName: '林澄' }], typeOptions: [{ id: 't1', label: '缺陷' }] };
    expect(trackingFilterSummary(DEFAULT_FILTER, names)).toBe('');
    expect(trackingFilterSummary({ ...DEFAULT_FILTER, product: 'p1', owner: 'gone', paused: true }, names)).toBe('当前筛选：产品：网盘，负责人：已不在列表中的负责人，只看暂停');
  });

  it('条目链接与写进展的对象', () => {
    expect(itemHref('acme', item({}))).toBe('/acme/requirements/PAN-1');
    const w = item({ kind: 'work_item', id: 'w1', displayKey: 'W-3', title: '协助', expectedDate: '2026-10-20', canEditDate: false });
    expect(itemHref('acme', w)).toBe('/acme/work-items/W-3');
    expect(targetOf(w)).toEqual({ type: 'work_item', id: 'w1', displayKey: 'W-3', title: '协助', expectedDate: '2026-10-20', canEditDate: false });
  });
});

describe('预计日', () => {
  it('空日期写未设置；未完成且早于今天标逾期；已完成不标', () => {
    expect(expectedDateView(null, { done: false, today: '2026-10-20' })).toEqual({ text: '未设置', overdue: false });
    expect(expectedDateView('', { done: false, today: '2026-10-20' })).toEqual({ text: '未设置', overdue: false });
    expect(expectedDateView('2026-10-01', { done: false, today: '2026-10-20' })).toEqual({ text: '2026-10-01', overdue: true });
    expect(expectedDateView('2026-10-20', { done: false, today: '2026-10-20' })).toEqual({ text: '2026-10-20', overdue: false });
    expect(expectedDateView('2026-10-01', { done: true, today: '2026-10-20' })).toEqual({ text: '2026-10-01', overdue: false });
  });
});

describe('派生视图', () => {
  it('任务老化：未完成的条目按停留降序，同天按编号；无进展只取 stale', () => {
    const items = [
      item({ id: 'a', displayKey: 'PAN-10', stageDays: 5 }),
      item({ id: 'b', displayKey: 'PAN-2', stageDays: 20, stale: true }),
      item({ id: 'c', displayKey: 'PAN-9', stageDays: 5, stale: true }),
      item({ id: 'd', displayKey: 'PAN-1', stageDays: 99, done: true }),
    ];
    expect(agingRows(items).map((i) => i.id)).toEqual(['b', 'c', 'a']);
    expect(staleRows(items).map((i) => i.id)).toEqual(['b', 'c']);
  });

  it('按阶段看板：选定产品按该产品非完成、非取消的状态分列；全部产品按类别，收集有条目才显示；工作项单独一列；已完成的不上看板', () => {
    const items = [
      item({ id: 'a', stage: { key: 'design', label: '设计中', color: '#60a5fa', category: 'unstarted' } }),
      item({ id: 'b' }),
      item({ id: 'c', done: true, stage: { key: 'done', label: '已上线', color: '#10b981', category: 'completed' } }),
      item({ id: 'w', kind: 'work_item', displayKey: 'W-1', product: null, stage: { key: 'active', label: '进行中', color: '#f59e0b', category: 'started' } }),
    ];
    expect(boardColumns(list(items), 'p1').map((c) => [c.label, c.items.map((i) => i.id)])).toEqual([
      ['收集', []],
      ['设计中', ['a']],
      ['开发中', ['b']],
      ['工作项', ['w']],
    ]);
    expect(boardColumns(list(items), null).map((c) => [c.label, c.items.map((i) => i.id)])).toEqual([
      ['未开始', ['a']],
      ['进行中', ['b']],
      ['工作项', ['w']],
    ]);
    const withBacklog = [...items, item({ id: 'k', stage: { key: 'collect', label: '收集', color: '#94a3b8', category: 'backlog' } })];
    expect(boardColumns(list(withBacklog), null).map((c) => c.label)).toEqual(['收集', '未开始', '进行中', '工作项']);
  });

  it('按产品经理：按姓名分组，没有负责人的排最后；组标题计数只算未完成的条目', () => {
    const zhang = { id: 'm2', displayName: '张三' };
    const li = { id: 'm1', displayName: '李四' };
    const groups = ownerGroups([
      item({ id: 'a', owner: zhang, paused: { at: '2026-10-01T00:00:00.000Z', reason: '等' } }),
      item({ id: 'b', owner: zhang, blockers: { count: 1, first: '等接口' }, aging: 'warn' }),
      item({ id: 'c', owner: zhang, done: true, aging: 'normal', blockers: { count: 1, first: '已完成的' } }),
      item({ id: 'd', owner: null }),
      item({ id: 'e', owner: li, aging: 'alert' }),
    ]);
    expect(groups.map((g) => [g.name, g.items.length, g.paused, g.blocked, g.aging])).toEqual([
      ['李四', 1, 0, 0, 1],
      ['张三', 3, 1, 1, 1],
      ['未指定负责人', 1, 0, 0, 0],
    ]);
  });
});
