import { describe, expect, it } from 'vitest';
import {
  addDays,
  completionOf,
  completionsOf,
  flowSummary,
  mondayOf,
  prepareFlow,
  quantile,
  stateAtEndOf,
  stuckNow,
  weeklySeries,
  weeksBetween,
  wipAt,
  zonedDate,
} from '../src/dashboard/metrics';
import { categoryOf, req, SH } from './dashboard-fixtures';

describe('日期与周', () => {
  it('周从周一开始；跨月、跨年正确', () => {
    expect(mondayOf('2026-10-13')).toBe('2026-10-12');
    expect(mondayOf('2026-10-12')).toBe('2026-10-12');
    expect(mondayOf('2026-10-18')).toBe('2026-10-12');
    expect(mondayOf('2026-10-19')).toBe('2026-10-19');
    expect(mondayOf('2027-01-01')).toBe('2026-12-28');
    expect(weeksBetween('2026-09-30', '2026-10-13')).toEqual(['2026-09-28', '2026-10-05', '2026-10-12']);
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('时刻按组织时区换算日期', () => {
    expect(zonedDate(new Date('2026-10-11T17:30:00Z'), SH)).toBe('2026-10-12');
    expect(zonedDate(new Date('2026-10-11T17:30:00Z'), 'UTC')).toBe('2026-10-11');
  });
});

describe('分位数', () => {
  it('线性插值；没有数据为 null', () => {
    expect(quantile([], 0.5)).toBeNull();
    expect(quantile([5], 0.85)).toBe(5);
    expect(quantile([4, 1, 3, 2], 0.5)).toBe(2.5);
    expect(quantile([1, 2, 3, 4], 0.85)).toBeCloseTo(3.55);
  });
});

describe('流转整理', () => {
  it('同一时刻时创建记录在前；没有流转的需求补一条创建记录', () => {
    const same = new Date('2026-10-01T02:00:00Z');
    const [a, b] = prepareFlow(
      [
        {
          id: 'a',
          createdAt: same,
          stateKey: 'doing',
          transitions: [
            { fromState: 'backlog', toState: 'doing', at: same },
            { fromState: null, toState: 'backlog', at: same },
          ],
        },
        { id: 'b', createdAt: same, stateKey: 'doing', transitions: [] },
      ],
      SH,
    );
    expect(a!.transitions.map((t) => t.toState)).toEqual(['backlog', 'doing']);
    expect(stateAtEndOf(a!, '2026-10-01')).toBe('doing');
    expect(b!.transitions).toEqual([{ fromState: null, toState: 'doing', at: same, date: '2026-10-01' }]);
    expect(stateAtEndOf(b!, '2026-09-30')).toBeNull();
  });
});

describe('完成记录', () => {
  const list = prepareFlow(
    [
      // 完成后重新打开、再次完成：按最后一次进入完成类计；流动时间从第一次进入进行中算起
      req('r1', '2026-09-01T10:00:00+08:00', [
        ['doing', '2026-09-02T10:00:00+08:00'],
        ['done', '2026-09-05T10:00:00+08:00'],
        ['doing', '2026-09-08T10:00:00+08:00'],
        ['done', '2026-09-10T10:00:00+08:00'],
      ]),
      // 完成类之间的流转（已完成 → 已验收）不算新的完成
      req('r2', '2026-09-01T10:00:00+08:00', [
        ['doing', '2026-09-03T10:00:00+08:00'],
        ['done', '2026-09-06T10:00:00+08:00'],
        ['accepted', '2026-09-09T10:00:00+08:00'],
      ]),
      // 完成后重新打开且当前未完成：不计
      req('r3', '2026-09-01T10:00:00+08:00', [
        ['done', '2026-09-05T10:00:00+08:00'],
        ['doing', '2026-09-08T10:00:00+08:00'],
      ]),
      // 已取消：不算完成
      req('r4', '2026-09-01T10:00:00+08:00', [
        ['doing', '2026-09-02T10:00:00+08:00'],
        ['canceled', '2026-09-04T10:00:00+08:00'],
      ]),
      // 没有经过进行中：前置时间照算，流动时间为 null
      req('r5', '2026-09-01T10:00:00+08:00', [['done', '2026-09-04T10:00:00+08:00']]),
    ],
    SH,
  );

  it('按最后一次从非完成类进入完成类计；重新打开或取消的不计', () => {
    expect(completionOf(list[0]!, categoryOf)).toEqual({ requirementId: 'r1', date: '2026-09-10', leadDays: 9, flowDays: 8 });
    expect(completionOf(list[1]!, categoryOf)).toEqual({ requirementId: 'r2', date: '2026-09-06', leadDays: 5, flowDays: 3 });
    expect(completionOf(list[2]!, categoryOf)).toBeNull();
    expect(completionOf(list[3]!, categoryOf)).toBeNull();
    expect(completionOf(list[4]!, categoryOf)).toEqual({ requirementId: 'r5', date: '2026-09-04', leadDays: 3, flowDays: null });
    expect(completionsOf(list, categoryOf).map((c) => c.requirementId)).toEqual(['r1', 'r2', 'r5']);
  });
});

describe('在制品、周趋势与时间段汇总', () => {
  const raw = [
    req('A', '2026-09-28T10:00:00+08:00', [
      ['doing', '2026-09-29T10:00:00+08:00'],
      ['done', '2026-10-07T10:00:00+08:00'],
    ]),
    // 北京时间周一 00:30 进入进行中，UTC 仍是周日
    req('B', '2026-09-28T10:00:00+08:00', [['doing', '2026-10-05T00:30:00+08:00']]),
    req('C', '2026-10-06T10:00:00+08:00', [
      ['doing', '2026-10-06T11:00:00+08:00'],
      ['canceled', '2026-10-09T10:00:00+08:00'],
    ]),
    req('D', '2026-10-12T10:00:00+08:00', []),
  ];

  it('在制品按某天结束时的状态推算；跨时区边界按组织时区', () => {
    const sh = prepareFlow(raw, SH);
    expect(wipAt(sh, categoryOf, '2026-09-27')).toBe(0);
    expect(wipAt(sh, categoryOf, '2026-10-04')).toBe(1);
    expect(wipAt(sh, categoryOf, '2026-10-06')).toBe(3);
    expect(wipAt(sh, categoryOf, '2026-10-11')).toBe(1);
    expect(wipAt(prepareFlow(raw, 'UTC'), categoryOf, '2026-10-04')).toBe(2);
  });

  it('周趋势：每周吞吐量、周末在制品、当周完成需求的 85 分位；最后一周算到时间段最后一天', () => {
    const sh = prepareFlow(raw, SH);
    expect(weeklySeries(sh, completionsOf(sh, categoryOf), categoryOf, '2026-09-30', '2026-10-13')).toEqual([
      { week: '2026-09-28', throughput: 0, wip: 1, leadP85: null, flowP85: null },
      { week: '2026-10-05', throughput: 1, wip: 1, leadP85: 9, flowP85: 8 },
      { week: '2026-10-12', throughput: 0, wip: 1, leadP85: null, flowP85: null },
    ]);
  });

  it('时间段汇总：周均吞吐量、中位数与 85 分位、最后一天的在制品', () => {
    const sh = prepareFlow(raw, SH);
    const done = completionsOf(sh, categoryOf);
    expect(flowSummary(sh, done, categoryOf, '2026-09-30', '2026-10-13')).toEqual({
      completed: 1,
      throughputPerWeek: 0.5,
      leadMedian: 9,
      leadP85: 9,
      flowMedian: 8,
      flowP85: 8,
      wip: 1,
    });
    expect(flowSummary(sh, done, categoryOf, '2026-09-16', '2026-09-29')).toEqual({
      completed: 0,
      throughputPerWeek: 0,
      leadMedian: null,
      leadP85: null,
      flowMedian: null,
      flowP85: null,
      wip: 1,
    });
  });

  it('卡在哪儿：当前进行中类的需求按状态统计平均停留，停留最久的按天数倒序取前 N 条', () => {
    const list = prepareFlow(
      [
        ...raw,
        req('E', '2026-10-01T10:00:00+08:00', [
          ['doing', '2026-10-02T10:00:00+08:00'],
          ['testing', '2026-10-10T10:00:00+08:00'],
        ]),
        req('F', '2026-10-11T10:00:00+08:00', [['doing', '2026-10-12T10:00:00+08:00']]),
      ],
      SH,
    );
    const s = stuckNow(list, categoryOf, new Date('2026-10-13T10:00:00+08:00'), 2);
    expect(s.states).toEqual([
      { key: 'doing', count: 2, avgDays: 4.7 },
      { key: 'testing', count: 1, avgDays: 3 },
    ]);
    expect(s.oldest).toEqual([
      { id: 'B', stateKey: 'doing', days: 8.4 },
      { id: 'E', stateKey: 'testing', days: 3 },
    ]);
  });
});
