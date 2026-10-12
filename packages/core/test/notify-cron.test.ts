import { describe, expect, it } from 'vitest';
import { assertCron, assertTimezone, nextRunAt } from '../src/notifications/cron';

describe('cron', () => {
  it('只接受 5 段；规范化空白；字段越界或写错时报错', () => {
    expect(assertCron('  0  19 * *   1-5 ')).toBe('0 19 * * 1-5');
    expect(() => assertCron('0 0 19 * * 1')).toThrow('5 段');
    expect(() => assertCron('')).toThrow('5 段');
    expect(() => assertCron('61 * * * *')).toThrow('无法解析');
    expect(() => assertCron('0 25 * * *')).toThrow('无法解析');
  });

  it('时区必须是 IANA 名称', () => {
    expect(assertTimezone(' Asia/Shanghai ')).toBe('Asia/Shanghai');
    expect(() => assertTimezone('Mars/Base')).toThrow('时区');
    expect(() => assertTimezone('')).toThrow('时区');
  });

  it('按时区计算下一次：工作日 19:00（上海）；严格晚于给定时间', () => {
    // 2026-10-10 是周六
    expect(nextRunAt('0 19 * * 1-5', 'Asia/Shanghai', new Date('2026-10-10T03:00:00Z')).toISOString()).toBe('2026-10-12T11:00:00.000Z');
    expect(nextRunAt('0 19 * * 1-5', 'Asia/Shanghai', new Date('2026-10-12T11:00:00Z')).toISOString()).toBe('2026-10-13T11:00:00.000Z');
    expect(nextRunAt('30 9 * * *', 'Asia/Shanghai', new Date('2026-10-10T01:29:00Z')).toISOString()).toBe('2026-10-10T01:30:00.000Z');
    expect(nextRunAt('0 0 1 * *', 'UTC', new Date('2026-10-10T00:00:00Z')).toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });

  it('夏令时切换日按当地时间计算', () => {
    // 美国东部 2026-11-01 结束夏令时：前一天 9:00 为 UTC 13:00，当天 9:00 为 UTC 14:00
    expect(nextRunAt('0 9 * * *', 'America/New_York', new Date('2026-10-31T12:00:00Z')).toISOString()).toBe('2026-10-31T13:00:00.000Z');
    expect(nextRunAt('0 9 * * *', 'America/New_York', new Date('2026-10-31T14:00:00Z')).toISOString()).toBe('2026-11-01T14:00:00.000Z');
  });
});
