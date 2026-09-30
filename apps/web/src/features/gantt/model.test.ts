import { describe, expect, it } from 'vitest';
import type { MemberTask } from '@/lib/types';
import { groupByIteration, heatClass, heatRows, parseHalfDays, parseProgress, shortDate, timelineCells, upcomingWorkdays } from './model';

describe('甘特输入解析', () => {
  it('工期、延期以半天为单位；空表示未填；提示文字与服务端一致', () => {
    expect(parseHalfDays('', 0.5, '工期')).toEqual({ ok: true, value: null });
    expect(parseHalfDays(' 1.5 ', 0.5, '工期')).toEqual({ ok: true, value: 1.5 });
    expect(parseHalfDays('0.3', 0.5, '工期')).toEqual({ ok: false, message: '工期以半天为单位，范围 0.5–365 天' });
    expect(parseHalfDays('0', 0.5, '工期')).toEqual({ ok: false, message: '工期以半天为单位，范围 0.5–365 天' });
    expect(parseHalfDays('0', 0, '延期')).toEqual({ ok: true, value: 0 });
    expect(parseHalfDays('abc', 0, '延期')).toEqual({ ok: false, message: '延期以半天为单位，范围 0–365 天' });
  });

  it('手动进度：空表示按工期推算，否则为 0–100 的整数', () => {
    expect(parseProgress('')).toEqual({ ok: true, value: null });
    expect(parseProgress('60')).toEqual({ ok: true, value: 60 });
    expect(parseProgress('60.5')).toEqual({ ok: false, message: '进度应为 0–100 的整数' });
    expect(parseProgress('101')).toEqual({ ok: false, message: '进度应为 0–100 的整数' });
  });
});

describe('热力图与时间轴', () => {
  // 09-24 周四、09-25 周五、09-28 周一、09-29 周二、09-30 周三
  const days = ['2026-09-24', '2026-09-25', '2026-09-28', '2026-09-29', '2026-09-30'];

  it('每个负责人一行，按姓名排序；未指派的任务不计；周末不占列', () => {
    const a = { id: 'a', displayName: '乙' };
    const b = { id: 'b', displayName: '甲' };
    const r = heatRows(
      [
        { assignee: a, planStart: '2026-09-25', planDays: 5, delayDays: 0 },
        { assignee: a, planStart: '2026-09-24', planDays: 1, delayDays: 0 },
        { assignee: b, planStart: '2026-09-30', planDays: 1, delayDays: null },
        { assignee: null, planStart: '2026-09-24', planDays: 3, delayDays: 0 },
      ],
      days,
    );
    expect(r).toEqual({
      rows: [
        { id: 'b', name: '甲', counts: [0, 0, 0, 0, 1] },
        { id: 'a', name: '乙', counts: [1, 1, 1, 1, 0] },
      ],
      max: 1,
    });
    expect(heatRows([], days)).toEqual({ rows: [], max: 1 });
    expect(heatClass(0, 4)).toBe('bg-muted');
    expect(heatClass(4, 4)).toBe('bg-primary');
  });

  it('时间轴格子区分计划内与延期；没有开始日期的全空', () => {
    expect(timelineCells({ planStart: '2026-09-28', planDays: 2, delayDays: 1 }, days)).toEqual([null, null, 'plan', 'plan', 'delay']);
    expect(timelineCells({ planStart: null, planDays: 2, delayDays: 0 }, days)).toEqual([null, null, null, null, null]);
  });

  it('日期显示与从今天起的工作日', () => {
    expect(shortDate('2026-01-05')).toBe('1/5');
    expect(upcomingWorkdays('2026-09-30', 1)).toEqual(['2026-09-30', '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06']);
  });
});

describe('人员负载', () => {
  it('按迭代分组：迭代按开始日期倒序，不在迭代中的放最后', () => {
    const first = { id: 'i1', name: '迭代0105', startDate: '2026-01-05', endDate: '2026-01-16', status: 'active' as const };
    const second = { id: 'i2', name: '迭代0119', startDate: '2026-01-19', endDate: '2026-01-30', status: 'planning' as const };
    const task = (id: string, iteration: typeof first | typeof second | null) => ({ id, iteration }) as unknown as MemberTask;
    const groups = groupByIteration([task('a', first), task('b', null), task('c', second), task('d', first)]);
    expect(groups.map((g) => [g.key, g.tasks.map((t) => t.id)])).toEqual([
      ['i2', ['c']],
      ['i1', ['a', 'd']],
      ['none', ['b']],
    ]);
  });
});
