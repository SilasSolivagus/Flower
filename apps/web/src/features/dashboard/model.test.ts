import { describe, expect, it } from 'vitest';
import {
  CARD_SPECS,
  cardDelta,
  cardLabel,
  customRangeError,
  dashboardHref,
  DEFAULT_FILTER,
  emptyReason,
  filterFromParams,
  filterQuery,
  formatDays,
  formatMetric,
  formatRate,
  linePoints,
  niceMax,
  orgDashboardHref,
  rangeValue,
  releaseVerdict,
  weekLabel,
  windowText,
} from './model';

const p = (s: string) => new URLSearchParams(s);
const ITERATION_ID = '0190a0b0-0000-7000-8000-000000000001';

describe('筛选与地址', () => {
  it('地址栏参数转成筛选；不认识的值回到近 90 天', () => {
    expect(filterFromParams(p(''))).toEqual(DEFAULT_FILTER);
    expect(filterFromParams(p('range=30'))).toEqual({ kind: 'days', days: 30 });
    expect(filterFromParams(p('range=180'))).toEqual({ kind: 'days', days: 180 });
    expect(filterFromParams(p('range=7'))).toEqual(DEFAULT_FILTER);
    expect(filterFromParams(p('from=2026-09-01&to=2026-09-30'))).toEqual({ kind: 'custom', from: '2026-09-01', to: '2026-09-30' });
    expect(filterFromParams(p('from=2026-09-01'))).toEqual(DEFAULT_FILTER);
    expect(filterFromParams(p(`iteration=${ITERATION_ID}&range=30`))).toEqual({ kind: 'iteration', iterationId: ITERATION_ID });
    expect(filterFromParams(p('iteration=abc'))).toEqual(DEFAULT_FILTER);
    expect(filterFromParams(p(`iteration=${ITERATION_ID}&range=30`), false)).toEqual({ kind: 'days', days: 30 });
  });

  it('筛选转成查询串与页面地址；默认值不写进地址', () => {
    expect(filterQuery(DEFAULT_FILTER)).toBe('');
    expect(filterQuery({ kind: 'days', days: 180 })).toBe('range=180');
    expect(filterQuery({ kind: 'custom', from: '2026-09-01', to: '2026-09-30' })).toBe('from=2026-09-01&to=2026-09-30');
    expect(filterQuery({ kind: 'iteration', iterationId: ITERATION_ID })).toBe(`iteration=${ITERATION_ID}`);
    expect(rangeValue({ kind: 'days', days: 30 })).toBe('30');
    expect(rangeValue({ kind: 'custom', from: '2026-09-01', to: '2026-09-30' })).toBe('custom');
    expect(dashboardHref('acme', 'p1')).toBe('/acme/dashboard?product=p1');
    expect(dashboardHref('acme', 'p1', { kind: 'days', days: 30 })).toBe('/acme/dashboard?product=p1&range=30');
    expect(orgDashboardHref('acme', DEFAULT_FILTER)).toBe('/acme/settings/dashboard');
    expect(orgDashboardHref('acme', { kind: 'days', days: 180 })).toBe('/acme/settings/dashboard?range=180');
  });

  it('自定义时间段的前端校验', () => {
    expect(customRangeError('', '2026-10-01', '2026-10-13')).toBe('请选择开始和结束日期');
    expect(customRangeError('2026-10-05', '2026-10-01', '2026-10-13')).toBe('结束日期不能早于开始日期');
    expect(customRangeError('2026-10-01', '2026-10-14', '2026-10-13')).toBe('结束日期不能晚于今天');
    expect(customRangeError('2025-01-01', '2026-10-13', '2026-10-13')).toBe('自定义时间段不超过 366 天');
    expect(customRangeError('2026-10-01', '2026-10-13', '2026-10-13')).toBeNull();
  });

  it('时间段说明', () => {
    const base = { from: '2026-07-16', to: '2026-10-13', days: 90, previousFrom: '2026-04-17', previousTo: '2026-07-15', iteration: null };
    expect(windowText(base)).toBe('2026-07-16 至 2026-10-13（90 天），与上期 2026-04-17 至 2026-07-15 比较');
    expect(windowText({ from: '2026-09-01', to: '2026-09-30', days: 30, previousFrom: '2026-08-02', previousTo: '2026-08-31', iteration: { id: 'i', name: '第 1 轮' } })).toBe(
      '迭代「第 1 轮」：2026-09-01 至 2026-09-30（30 天），与上期 2026-08-02 至 2026-08-31 比较',
    );
  });
});

describe('数字、升降与空数据原因', () => {
  it('按单位格式化；没有数据显示「暂无数据」', () => {
    expect(formatMetric(null, 'rate')).toBe('暂无数据');
    expect(formatMetric(0.5, 'rate')).toBe('50%');
    expect(formatMetric(17, 'days')).toBe('17.0 天');
    expect(formatMetric(0.2, 'perWeek')).toBe('0.2 条/周');
    expect(formatMetric(3, 'count')).toBe('3');
    expect(formatDays(null)).toBe('暂无数据');
    expect(formatDays(64.1)).toBe('64.1 天');
    expect(formatRate(0.3333)).toBe('33%');
  });

  it('与上期比较：方向、好坏与文字；任一侧没有数据时不显示', () => {
    expect(cardDelta({ value: 0.2, previous: 0.1 }, 'perWeek', 'up')).toEqual({ direction: 'up', tone: 'good', text: '比上期升 0.1 条/周' });
    expect(cardDelta({ value: 17, previous: 19 }, 'days', 'down')).toEqual({ direction: 'down', tone: 'good', text: '比上期降 2.0 天' });
    expect(cardDelta({ value: 0.5, previous: 0.3 }, 'rate', 'down')).toEqual({ direction: 'up', tone: 'bad', text: '比上期升 20 个百分点' });
    expect(cardDelta({ value: 3, previous: 1 }, 'count', 'down')).toEqual({ direction: 'up', tone: 'bad', text: '比上期升 2' });
    expect(cardDelta({ value: 2, previous: 2 }, 'count', 'down')).toEqual({ direction: 'flat', tone: 'neutral', text: '与上期持平' });
    expect(cardDelta({ value: 1, previous: null }, 'count', 'down')).toBeNull();
    expect(cardDelta({ value: null, previous: 1 }, 'count', 'down')).toBeNull();
  });

  it('空数据原因：流动时间区分「没有完成的需求」与「完成的需求没有经过进行中」', () => {
    expect(emptyReason('throughputPerWeek', 0)).toBe('时间段内还没有需求');
    expect(emptyReason('leadTimeMedian', 0)).toBe('时间段内没有完成的需求');
    expect(emptyReason('flowTimeMedian', 0)).toBe('时间段内没有完成的需求');
    expect(emptyReason('flowTimeMedian', 2)).toBe('时间段内完成的需求都没有经过进行中状态');
    expect(emptyReason('releaseOnTimeRate', 0)).toBe('时间段内没有能判断是否按期的已发布版本');
    expect(emptyReason('rejectionRate', 0)).toBe('时间段内没有有结论的检查项');
  });
});

describe('图表与版本结论', () => {
  it('纵轴上限取 1、2、5 的整数倍；没有数据时为 1', () => {
    expect(niceMax([])).toBe(1);
    expect(niceMax([0, 0])).toBe(1);
    expect(niceMax([3])).toBe(5);
    expect(niceMax([7, null])).toBe(10);
    expect(niceMax([12])).toBe(20);
    expect(niceMax([0.85])).toBe(1);
  });

  it('折线坐标：null 处断开；只有一个点时居中', () => {
    expect(linePoints([1, null, 2, 4], 300, 100, 4)).toEqual([[{ x: 0, y: 75 }], [{ x: 200, y: 50 }, { x: 300, y: 0 }]]);
    expect(linePoints([2], 300, 100, 4)).toEqual([[{ x: 150, y: 50 }]]);
    expect(linePoints([null, null], 300, 100, 4)).toEqual([]);
    expect(weekLabel('2026-10-05')).toBe('10/5');
  });

  it('版本结论：按到期日来源给出措辞，已发布的不会写「没有计划日期」', () => {
    const rel = (o: object) => ({ status: 'released' as const, dueDate: '2026-09-25', dueSource: 'baseline' as const, onTime: true, overdueDays: 0, ...o });
    expect(releaseVerdict(rel({}))).toEqual({ text: '按期', tone: 'good' });
    expect(releaseVerdict(rel({ dueDate: '2026-09-30', onTime: false, overdueDays: 2 }))).toEqual({ text: '逾期 2 天', tone: 'bad' });
    expect(releaseVerdict(rel({ dueSource: 'iteration' }))).toEqual({ text: '按期，按迭代结束日计', tone: 'good' });
    expect(releaseVerdict(rel({ dueSource: 'iteration', onTime: false, overdueDays: 4 }))).toEqual({ text: '逾期 4 天，按迭代结束日计', tone: 'bad' });
    const unjudgeable = releaseVerdict(rel({ dueDate: null, dueSource: null, onTime: null, overdueDays: null }));
    expect(unjudgeable).toEqual({ text: '无法判断：没有基线日期，所属迭代也没有结束日', tone: 'neutral' });
    expect(unjudgeable.text).not.toContain('没有计划日期');
    expect(releaseVerdict(rel({ dueSource: 'baseline' })).text).not.toContain('没有计划日期');
    const pend = (o: object) => ({ status: 'planned' as const, dueDate: '2026-10-10', dueSource: 'planned' as const, onTime: null, overdueDays: 3, ...o });
    expect(releaseVerdict(pend({}))).toEqual({ text: '未发布，已过计划日 3 天', tone: 'bad' });
    expect(releaseVerdict(pend({ dueSource: 'iteration' }))).toEqual({ text: '未发布，已过迭代结束日 3 天', tone: 'bad' });
    expect(releaseVerdict(pend({ dueDate: '2026-10-20', overdueDays: 0 }))).toEqual({ text: '未发布', tone: 'neutral' });
    expect(releaseVerdict(pend({ dueDate: '2026-10-20', dueSource: 'iteration', overdueDays: 0 }))).toEqual({ text: '未发布，按迭代结束日计', tone: 'neutral' });
    expect(releaseVerdict(pend({ dueDate: null, dueSource: null, overdueDays: null }))).toEqual({ text: '未发布，没有计划日期，所属迭代也没有结束日', tone: 'neutral' });
  });

  it('在制品卡片名称：时间段到今天为「当前在制品」，否则为「期末在制品」', () => {
    const wip = CARD_SPECS.find((c) => c.key === 'wip')!;
    expect(cardLabel(wip, true)).toBe('当前在制品');
    expect(cardLabel(wip, false)).toBe('期末在制品');
    expect(cardLabel(CARD_SPECS[0]!, false)).toBe('吞吐量（周均）');
  });
});
