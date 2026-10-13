/**
 * 看板的流动指标（P3-B2）：日期与周的换算、分位数、需求完成记录、吞吐量、前置时间、流动时间、在制品与停留。
 * 纯函数，输入由 dashboard/flow.ts 从数据库读出，单测直接构造。日期一律为组织时区下的 YYYY-MM-DD，时刻为 Date。
 * 已删除的需求由调用方排除；「已取消」不算完成。
 */
import { dateOfDay, dayNumber } from '../tasks/schedule';

export type StateCategory = 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled';
export type CategoryOf = (stateKey: string) => StateCategory;

const DAY_MS = 86_400_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

/** 时刻在某个时区里的日期（YYYY-MM-DD）。格式化器按时区缓存，避免逐条新建。 */
export function zonedDate(at: Date, timeZone: string): string {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    formatters.set(timeZone, f);
  }
  return f.format(at);
}

export const addDays = (date: string, n: number): string => dateOfDay(dayNumber(date) + n);

/** to 减 from 的天数（同一天为 0）。 */
export const daysBetween = (from: string, to: string): number => dayNumber(to) - dayNumber(from);

/** 所在周的周一。dayNumber 为 0 的 1970-01-01 是周四，(n + 3) % 7 为以周一为 0 的星期序号。 */
export function mondayOf(date: string): string {
  const n = dayNumber(date);
  return dateOfDay(n - ((((n + 3) % 7) + 7) % 7));
}

/** from 到 to（都含）覆盖的每一周的周一，升序。 */
export function weeksBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const last = dayNumber(to);
  for (let d = dayNumber(mondayOf(from)); d <= last; d += 7) out.push(dateOfDay(d));
  return out;
}

/** 分位数，线性插值（与 Postgres 的 percentile_cont 相同）；没有数据时为 null。 */
export function quantile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

export const roundTo1 = (n: number): number => Math.round(n * 10) / 10;
export const round1 = (n: number | null): number | null => (n === null ? null : roundTo1(n));

/** 比例，保留 4 位小数；分母为 0 时为 null。 */
export const ratio = (n: number, d: number): number | null => (d > 0 ? Math.round((n / d) * 10000) / 10000 : null);

/** 两个时刻之间的天数（可带小数），不小于 0。 */
export const elapsedDays = (from: Date, to: Date): number => Math.max(0, (to.getTime() - from.getTime()) / DAY_MS);

export type RawTransition = { fromState: string | null; toState: string; at: Date };
export type RawRequirement = { id: string; createdAt: Date; stateKey: string; transitions: RawTransition[] };
export type FlowTransition = RawTransition & { date: string };
export type FlowRequirement = { id: string; createdAt: Date; stateKey: string; transitions: FlowTransition[] };

/**
 * 流转按时间升序排好并换算本地日期；同一时刻时创建记录（fromState 为空）在前。
 * 没有任何流转记录的需求补一条「创建时进入当前状态」，保证每条需求至少有一条。
 */
export function prepareFlow(list: RawRequirement[], timeZone: string): FlowRequirement[] {
  return list.map((r) => {
    const raw: RawTransition[] = r.transitions.length > 0 ? r.transitions : [{ fromState: null, toState: r.stateKey, at: r.createdAt }];
    const sorted = [...raw].sort((a, b) => a.at.getTime() - b.at.getTime() || Number(b.fromState === null) - Number(a.fromState === null));
    return { id: r.id, createdAt: r.createdAt, stateKey: r.stateKey, transitions: sorted.map((t) => ({ ...t, date: zonedDate(t.at, timeZone) })) };
  });
}

/** 某天结束时（组织时区）需求所处的状态；那天结束时还没有创建的为 null。 */
export function stateAtEndOf(r: FlowRequirement, date: string): string | null {
  let state: string | null = null;
  for (const t of r.transitions) {
    if (t.date > date) break;
    state = t.toState;
  }
  return state;
}

/** 某天结束时处于进行中类状态的需求数。 */
export function wipAt(reqs: FlowRequirement[], categoryOf: CategoryOf, date: string): number {
  let n = 0;
  for (const r of reqs) {
    const s = stateAtEndOf(r, date);
    if (s !== null && categoryOf(s) === 'started') n++;
  }
  return n;
}

export type Completion = { requirementId: string; date: string; leadDays: number; flowDays: number | null };

/**
 * 需求的完成记录：只对当前处于完成类的需求，取最后一次从非完成类（或创建）进入完成类的流转。
 * 前置时间从创建算起；流动时间从第一次进入进行中类算起，没有经过进行中的为 null。
 */
export function completionOf(r: FlowRequirement, categoryOf: CategoryOf): Completion | null {
  if (categoryOf(r.stateKey) !== 'completed') return null;
  let entry: FlowTransition | null = null;
  let firstStarted: Date | null = null;
  for (const t of r.transitions) {
    const to = categoryOf(t.toState);
    if (to === 'started' && firstStarted === null) firstStarted = t.at;
    if (to === 'completed' && (t.fromState === null || categoryOf(t.fromState) !== 'completed')) entry = t;
  }
  if (!entry) return null;
  return {
    requirementId: r.id,
    date: entry.date,
    leadDays: elapsedDays(r.createdAt, entry.at),
    flowDays: firstStarted && firstStarted.getTime() <= entry.at.getTime() ? elapsedDays(firstStarted, entry.at) : null,
  };
}

export function completionsOf(reqs: FlowRequirement[], categoryOf: CategoryOf): Completion[] {
  const out: Completion[] = [];
  for (const r of reqs) {
    const c = completionOf(r, categoryOf);
    if (c) out.push(c);
  }
  return out;
}

const inRange = (c: Completion, from: string, to: string) => c.date >= from && c.date <= to;
const flowDaysOf = (list: Completion[]): number[] => list.flatMap((c) => (c.flowDays === null ? [] : [c.flowDays]));

export type FlowSummary = {
  completed: number;
  throughputPerWeek: number;
  leadMedian: number | null;
  leadP85: number | null;
  flowMedian: number | null;
  flowP85: number | null;
  wip: number;
};

/** 时间段汇总：完成数、周均吞吐量（完成数 × 7 ÷ 天数）、前置与流动时间的中位数和 85 分位、最后一天结束时的在制品。 */
export function flowSummary(reqs: FlowRequirement[], completions: Completion[], categoryOf: CategoryOf, from: string, to: string): FlowSummary {
  const done = completions.filter((c) => inRange(c, from, to));
  const lead = done.map((c) => c.leadDays);
  const flow = flowDaysOf(done);
  const days = daysBetween(from, to) + 1;
  return {
    completed: done.length,
    throughputPerWeek: roundTo1((done.length * 7) / days),
    leadMedian: round1(quantile(lead, 0.5)),
    leadP85: round1(quantile(lead, 0.85)),
    flowMedian: round1(quantile(flow, 0.5)),
    flowP85: round1(quantile(flow, 0.85)),
    wip: wipAt(reqs, categoryOf, to),
  };
}

export type WeekPoint = { week: string; throughput: number; wip: number; leadP85: number | null; flowP85: number | null };

/** 周趋势：每周（周一开始）的完成数、周日结束时的在制品（最后一周取时间段最后一天）、当周完成需求的 85 分位。 */
export function weeklySeries(reqs: FlowRequirement[], completions: Completion[], categoryOf: CategoryOf, from: string, to: string): WeekPoint[] {
  const byWeek = new Map<string, Completion[]>();
  for (const c of completions) {
    if (!inRange(c, from, to)) continue;
    const w = mondayOf(c.date);
    byWeek.set(w, [...(byWeek.get(w) ?? []), c]);
  }
  return weeksBetween(from, to).map((week) => {
    const sunday = addDays(week, 6);
    const mine = byWeek.get(week) ?? [];
    return {
      week,
      throughput: mine.length,
      wip: wipAt(reqs, categoryOf, sunday < to ? sunday : to),
      leadP85: round1(quantile(mine.map((c) => c.leadDays), 0.85)),
      flowP85: round1(quantile(flowDaysOf(mine), 0.85)),
    };
  });
}

export type StuckState = { key: string; count: number; avgDays: number };
export type StuckItem = { id: string; stateKey: string; days: number };

/** 当前处于进行中类状态的需求：按具体状态统计数量与平均停留天数（自最后一次流转起，降序），以及停留最久的前 limit 条。 */
export function stuckNow(reqs: FlowRequirement[], categoryOf: CategoryOf, now: Date, limit = 10): { states: StuckState[]; oldest: StuckItem[] } {
  const items: Array<{ id: string; stateKey: string; raw: number }> = [];
  for (const r of reqs) {
    if (categoryOf(r.stateKey) !== 'started') continue;
    const last = r.transitions.at(-1);
    items.push({ id: r.id, stateKey: r.stateKey, raw: elapsedDays(last ? last.at : r.createdAt, now) });
  }
  const groups = new Map<string, number[]>();
  for (const i of items) groups.set(i.stateKey, [...(groups.get(i.stateKey) ?? []), i.raw]);
  const states = [...groups.entries()]
    .map(([key, days]) => ({ key, count: days.length, avgDays: roundTo1(days.reduce((a, b) => a + b, 0) / days.length) }))
    .sort((a, b) => b.avgDays - a.avgDays || a.key.localeCompare(b.key));
  const oldest = [...items]
    .sort((a, b) => b.raw - a.raw || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map((i) => ({ id: i.id, stateKey: i.stateKey, days: roundTo1(i.raw) }));
  return { states, oldest };
}
