/**
 * 工作跟进的停留与老化（P3-C1）：阈值、暂停区间、扣除暂停的天数、老化分档、无进展判定。
 * 纯函数。日期为组织时区下的 YYYY-MM-DD，时刻为 Date；天数按组织时区的自然日计算（同一天为 0）。
 */
import { daysBetween, zonedDate } from '../dashboard/metrics';

export type TrackingSettings = { warnDays: number; alertDays: number; staleUpdateDays: number };
export const DEFAULT_TRACKING_SETTINGS: TrackingSettings = { warnDays: 14, alertDays: 30, staleUpdateDays: 7 };

/** 第一次进入这两类状态时自动加入跟进。 */
export const TRACKED_CATEGORIES: readonly string[] = ['unstarted', 'started'];
/** 处于这两类状态的需求不算在手。 */
export const CLOSED_CATEGORIES: readonly string[] = ['completed', 'canceled'];

const validDays = (v: number | undefined): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 365;

/** 组织设置里的阈值：缺省或无效的项取默认值；标黄不小于标红时这两项回到默认值。 */
export function trackingSettingsOf(settings: { tracking?: Partial<TrackingSettings> }): TrackingSettings {
  const t = settings.tracking ?? {};
  const warnDays = validDays(t.warnDays) ? t.warnDays : DEFAULT_TRACKING_SETTINGS.warnDays;
  const alertDays = validDays(t.alertDays) ? t.alertDays : DEFAULT_TRACKING_SETTINGS.alertDays;
  const staleUpdateDays = validDays(t.staleUpdateDays) ? t.staleUpdateDays : DEFAULT_TRACKING_SETTINGS.staleUpdateDays;
  return warnDays < alertDays
    ? { warnDays, alertDays, staleUpdateDays }
    : { warnDays: DEFAULT_TRACKING_SETTINGS.warnDays, alertDays: DEFAULT_TRACKING_SETTINGS.alertDays, staleUpdateDays };
}

export type PauseEvent = { kind: 'paused' | 'resumed'; at: Date };
export type PauseInterval = { from: Date; to: Date | null };

/** 暂停、恢复事件 → 暂停区间（先按时间排序；已在暂停时的暂停、没有暂停时的恢复忽略）；最后一段没有恢复时 to 为 null。 */
export function pauseIntervals(events: PauseEvent[]): PauseInterval[] {
  const out: PauseInterval[] = [];
  let open: Date | null = null;
  for (const e of [...events].sort((a, b) => a.at.getTime() - b.at.getTime())) {
    if (e.kind === 'paused' && !open) open = e.at;
    else if (e.kind === 'resumed' && open) {
      out.push({ from: open, to: e.at });
      open = null;
    }
  }
  if (open) out.push({ from: open, to: null });
  return out;
}

const later = (a: string, b: string): string => (a > b ? a : b);
const earlier = (a: string, b: string): string => (a < b ? a : b);

/**
 * from 到 until（为 null 时到 today）之间的自然日天数，扣除与之相交的暂停区间（同样按自然日）。
 * 正在暂停的区间延伸到 today，相当于天数停在暂停开始那天。字符串参数是已换算好的本地日期。结果不小于 0。
 */
export function activeDays(from: Date | string, until: Date | string | null, today: string, intervals: PauseInterval[], timeZone: string): number {
  const local = (d: Date | string): string => (typeof d === 'string' ? d : zonedDate(d, timeZone));
  const start = local(from);
  const end = until === null ? today : local(until);
  if (end <= start) return 0;
  let paused = 0;
  for (const iv of intervals) {
    const s = later(start, local(iv.from));
    const e = earlier(end, iv.to ? local(iv.to) : today);
    if (e > s) paused += daysBetween(s, e);
  }
  return Math.max(0, daysBetween(start, end) - paused);
}

export type AgingLevel = 'normal' | 'warn' | 'alert';

/** 本阶段停留超过 warnDays 标黄、超过 alertDays 标红；暂停中的条目不标色。 */
export function agingLevel(stageDays: number, paused: boolean, s: TrackingSettings): AgingLevel {
  if (paused) return 'normal';
  if (stageDays > s.alertDays) return 'alert';
  if (stageDays > s.warnDays) return 'warn';
  return 'normal';
}

/** 无进展：最新一条进展（没有时为加入跟进的时间）距今超过 staleUpdateDays 个自然日；暂停中的条目不计。 */
export function isStale(lastUpdateAt: Date, paused: boolean, today: string, timeZone: string, s: TrackingSettings): boolean {
  return !paused && daysBetween(zonedDate(lastUpdateAt, timeZone), today) > s.staleUpdateDays;
}
