import { describe, expect, it } from 'vitest';
import { activeDays, agingLevel, DEFAULT_TRACKING_SETTINGS, isStale, pauseIntervals, trackingSettingsOf } from '../src/tracking/aging';

const SH = 'Asia/Shanghai';
const at = (iso: string) => new Date(iso);
const S = DEFAULT_TRACKING_SETTINGS;

describe('暂停区间', () => {
  it('按时间配对暂停与恢复；重复的暂停、没有暂停的恢复忽略；最后一段没有恢复时 to 为 null', () => {
    expect(
      pauseIntervals([
        { kind: 'resumed', at: at('2026-10-01T02:00:00Z') },
        { kind: 'paused', at: at('2026-10-02T02:00:00Z') },
        { kind: 'paused', at: at('2026-10-03T02:00:00Z') },
        { kind: 'resumed', at: at('2026-10-05T02:00:00Z') },
        { kind: 'paused', at: at('2026-10-10T02:00:00Z') },
      ]),
    ).toEqual([
      { from: at('2026-10-02T02:00:00Z'), to: at('2026-10-05T02:00:00Z') },
      { from: at('2026-10-10T02:00:00Z'), to: null },
    ]);
  });

  it('乱序输入先按时间排序', () => {
    expect(
      pauseIntervals([
        { kind: 'resumed', at: at('2026-10-05T02:00:00Z') },
        { kind: 'paused', at: at('2026-10-02T02:00:00Z') },
      ]),
    ).toEqual([{ from: at('2026-10-02T02:00:00Z'), to: at('2026-10-05T02:00:00Z') }]);
  });
});

describe('扣除暂停的天数', () => {
  it('没有暂停：组织时区下的自然日之差', () => {
    // 北京时间 10-13 00:30 进入，当天为 0；按 UTC 算会落到 10-12，多出 1 天
    expect(activeDays(at('2026-10-12T16:30:00Z'), null, '2026-10-13', [], SH)).toBe(0);
    expect(activeDays(at('2026-10-12T16:30:00Z'), null, '2026-10-13', [], 'UTC')).toBe(1);
    expect(activeDays(at('2026-10-01T02:00:00Z'), null, '2026-10-13', [], SH)).toBe(12);
  });

  it('多次暂停都扣除；同一天内暂停又恢复不扣', () => {
    const ivs = [
      { from: at('2026-10-03T02:00:00Z'), to: at('2026-10-05T02:00:00Z') },
      { from: at('2026-10-07T02:00:00Z'), to: at('2026-10-07T08:00:00Z') },
      { from: at('2026-10-09T02:00:00Z'), to: at('2026-10-10T02:00:00Z') },
    ];
    expect(activeDays(at('2026-10-01T02:00:00Z'), null, '2026-10-13', ivs, SH)).toBe(9);
  });

  it('暂停跨状态变化：暂停开始早于进入当前状态时，只扣进入之后的部分', () => {
    const ivs = [{ from: at('2026-10-01T02:00:00Z'), to: at('2026-10-08T02:00:00Z') }];
    expect(activeDays(at('2026-10-05T02:00:00Z'), null, '2026-10-13', ivs, SH)).toBe(5);
  });

  it('正在暂停：天数停在暂停开始那天', () => {
    const ivs = [{ from: at('2026-10-10T02:00:00Z'), to: null }];
    expect(activeDays(at('2026-10-01T02:00:00Z'), null, '2026-10-13', ivs, SH)).toBe(9);
  });

  it('有结束时刻（已完成）时算到结束那天；起点可以是本地日期；起点晚于今天时为 0', () => {
    expect(activeDays('2026-10-01', at('2026-10-06T02:00:00Z'), '2026-10-13', [], SH)).toBe(5);
    expect(activeDays('2026-10-14', null, '2026-10-13', [], SH)).toBe(0);
  });
});

describe('老化与无进展', () => {
  it('超过 14 天标黄、超过 30 天标红；暂停中不标色', () => {
    expect(agingLevel(14, false, S)).toBe('normal');
    expect(agingLevel(15, false, S)).toBe('warn');
    expect(agingLevel(30, false, S)).toBe('warn');
    expect(agingLevel(31, false, S)).toBe('alert');
    expect(agingLevel(99, true, S)).toBe('normal');
  });

  it('最新进展距今超过 7 天为无进展；暂停中不计', () => {
    expect(isStale(at('2026-10-06T02:00:00Z'), false, '2026-10-13', SH, S)).toBe(false);
    expect(isStale(at('2026-10-05T02:00:00Z'), false, '2026-10-13', SH, S)).toBe(true);
    expect(isStale(at('2026-10-01T02:00:00Z'), true, '2026-10-13', SH, S)).toBe(false);
  });

  it('组织设置：缺省或无效项取默认值；标黄不小于标红时这两项回到默认值', () => {
    expect(trackingSettingsOf({})).toEqual(S);
    expect(trackingSettingsOf({ tracking: { warnDays: 7, alertDays: 21, staleUpdateDays: 3 } })).toEqual({ warnDays: 7, alertDays: 21, staleUpdateDays: 3 });
    expect(trackingSettingsOf({ tracking: { warnDays: 0, alertDays: 1.5 } })).toEqual(S);
    expect(trackingSettingsOf({ tracking: { warnDays: 40, alertDays: 30, staleUpdateDays: 5 } })).toEqual({ ...S, staleUpdateDays: 5 });
  });
});
