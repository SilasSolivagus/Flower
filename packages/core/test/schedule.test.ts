import { describe, expect, it } from 'vitest';
import {
  coverKind,
  displayProgress,
  heatLevel,
  iterationOverview,
  loadCounts,
  type OverviewTask,
  theoreticalProgress,
  todayInZone,
  workdaysBetween,
  workdaysElapsed,
} from '../src/tasks/schedule';

const task = (over: Partial<OverviewTask>): OverviewTask => ({
  status: 'doing',
  planStart: null,
  planDays: null,
  delayDays: null,
  progressOverride: null,
  requirementId: null,
  title: '任务',
  flag: null,
  note: null,
  assigneeName: null,
  ...over,
});

describe('工作日', () => {
  it('从开始日（不含）数到今天（含），跳过周六日；今天不晚于开始日时为 0', () => {
    expect(workdaysElapsed('2026-09-24', '2026-09-24')).toBe(0);
    expect(workdaysElapsed('2026-09-24', '2026-09-28')).toBe(2);
    expect(workdaysElapsed('2026-09-25', '2026-09-27')).toBe(0);
    expect(workdaysElapsed('2026-09-28', '2026-09-24')).toBe(0);
  });

  it('区间内的工作日（含两端）', () => {
    expect(workdaysBetween('2026-09-24', '2026-09-30')).toEqual(['2026-09-24', '2026-09-25', '2026-09-28', '2026-09-29', '2026-09-30']);
    expect(workdaysBetween('2026-09-26', '2026-09-27')).toEqual([]);
  });

  it('组织时区的当天日期', () => {
    const now = new Date('2026-09-30T17:00:00Z');
    expect(todayInZone('Asia/Shanghai', now)).toBe('2026-10-01');
    expect(todayInZone('UTC', now)).toBe('2026-09-30');
  });
});

describe('进度', () => {
  it('理论进度 = 已过工作日 ÷ max(1, 工期 + 延期)，半天任务按 1 天算', () => {
    expect(theoreticalProgress('2026-09-24', 4, 0, '2026-09-28')).toBe(50);
    expect(theoreticalProgress('2026-09-24', 4, 1, '2026-09-28')).toBe(40);
    expect(theoreticalProgress('2026-09-24', 0.5, null, '2026-09-24')).toBe(0);
    expect(theoreticalProgress('2026-09-24', 0.5, null, '2026-09-25')).toBe(100);
    expect(theoreticalProgress('2026-09-24', 1.5, 0, '2026-09-25')).toBe(67);
    expect(theoreticalProgress('2026-09-24', 2, 0, '2026-10-09')).toBe(100);
  });

  it('展示进度：已完成 = 100，手动进度优先（取整并限制在 0–100），没有开始日期 = 0', () => {
    const base = { planStart: '2026-09-24', planDays: 4, delayDays: 0 };
    expect(displayProgress({ ...base, status: 'done', progressOverride: 30 }, '2026-09-28')).toBe(100);
    expect(displayProgress({ ...base, status: 'doing', progressOverride: 42.4 }, '2026-09-28')).toBe(42);
    expect(displayProgress({ ...base, status: 'doing', progressOverride: 150 }, '2026-09-28')).toBe(100);
    expect(displayProgress({ ...base, planStart: null, status: 'todo', progressOverride: null }, '2026-09-28')).toBe(0);
    expect(displayProgress({ ...base, status: 'doing', progressOverride: null }, '2026-09-28')).toBe(50);
  });
});

describe('覆盖规则与热力图', () => {
  it('按自然日覆盖 [开始, 开始 + max(0.5, 工期 + 延期))，区分计划内与延期', () => {
    const t = { planStart: '2026-09-24', planDays: 2, delayDays: 1 };
    expect(['2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27'].map((d) => coverKind(t, d))).toEqual(['plan', 'plan', 'delay', null]);
    expect(coverKind({ planStart: '2026-09-24', planDays: 0.5, delayDays: null }, '2026-09-24')).toBe('plan');
    expect(coverKind({ planStart: '2026-09-24', planDays: null, delayDays: null }, '2026-09-25')).toBeNull();
    expect(coverKind({ planStart: null, planDays: 3, delayDays: 0 }, '2026-09-24')).toBeNull();
  });

  it('周五开始的 5 天任务在工作日列上只占周五、周一、周二', () => {
    const days = workdaysBetween('2026-09-24', '2026-09-30');
    const friday = { planStart: '2026-09-25', planDays: 5, delayDays: 0 };
    const thursday = { planStart: '2026-09-24', planDays: 1, delayDays: 0 };
    expect(loadCounts([friday], days)).toEqual([0, 1, 1, 1, 0]);
    expect(loadCounts([friday, thursday], days)).toEqual([1, 1, 1, 1, 0]);
  });

  it('色阶按与最大值之比分 5 档', () => {
    expect([0, 1, 2, 3, 4].map((c) => heatLevel(c, 4))).toEqual([0, 1, 2, 3, 4]);
    expect(heatLevel(1, 0)).toBe(4);
  });
});

describe('迭代概览', () => {
  const sprint = { startDate: '2026-09-28', endDate: '2026-10-09' };

  it('按需求（无需求按标题）聚合；关注且未完成的不计入整体进度；关注与周知按标题去重', () => {
    const o = iterationOverview(
      [
        task({ requirementId: 'r1', title: 'PAN-1 上传提速', status: 'done' }),
        task({ requirementId: 'r1', title: 'PAN-1 上传提速', progressOverride: 50, assigneeName: '开发乙' }),
        task({ requirementId: 'r2', title: 'PAN-2 分享统计', flag: 'attention', progressOverride: 20 }),
        task({ title: '联调', progressOverride: 40, note: '等待接口' }),
        task({ title: ' 联调 ', progressOverride: 60 }),
        task({ requirementId: 'r3', title: 'PAN-3 回收站', flag: 'attention', status: 'done' }),
        task({ title: '  ' }),
      ],
      sprint,
      '2026-10-02',
    );
    expect(o).toEqual({
      rowCount: 4,
      countedCount: 3,
      overall: 75,
      expected: 44,
      behind: 0,
      deferred: 1,
      attention: [
        { kind: 'attention', title: 'PAN-2 分享统计', assignees: [], note: '' },
        { kind: 'notice', title: '联调', assignees: [], note: '等待接口' },
        { kind: 'attention', title: 'PAN-3 回收站', assignees: [], note: '' },
      ],
    });
  });

  it('落后 = 理论进度 − 整体进度；迭代结束后理论进度为 100；没有可计入的行时整体为 0', () => {
    expect(iterationOverview([task({ title: '埋点', progressOverride: 10 })], sprint, '2026-10-02')).toMatchObject({ overall: 10, expected: 44, behind: 34 });
    expect(iterationOverview([task({ title: '埋点', progressOverride: 10 })], sprint, '2026-10-20')).toMatchObject({ expected: 100, behind: 90 });
    expect(iterationOverview([], sprint, '2026-10-02')).toMatchObject({ rowCount: 0, overall: 0, behind: 44, deferred: 0 });
  });
});
