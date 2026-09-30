/**
 * 排期与进度的纯函数。服务端（进度、概览）与浏览器（时间轴、热力图）共用：
 * 通过 `@flower/core/schedule` 导入，因此本文件不能导入任何其他模块。日期一律为 YYYY-MM-DD。
 */

export const STARRED_LIMIT = 10;
export const TASK_FLAGS = ['attention'] as const;
export type TaskFlag = (typeof TASK_FLAGS)[number];

const DAY_MS = 86_400_000;

/** YYYY-MM-DD → 自 1970-01-01 起的天数（按 UTC 计算，不受运行环境时区影响）。 */
export function dayNumber(date: string): number {
  return Math.round(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) / DAY_MS);
}

export function dateOfDay(n: number): string {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

export function isWeekend(n: number): boolean {
  const w = new Date(n * DAY_MS).getUTCDay();
  return w === 0 || w === 6;
}

/** 开始日（不含）到今天（含）之间的工作日数，跳过周六日；今天不晚于开始日时为 0。与 push 的算法一致。 */
export function workdaysElapsed(planStart: string, today: string): number {
  const end = dayNumber(today);
  let n = 0;
  for (let d = dayNumber(planStart) + 1; d <= end; d++) if (!isWeekend(d)) n++;
  return n;
}

/** 按工期（含延期）推算的理论进度，0–100 取整；工期不足 1 天按 1 天算。 */
export function theoreticalProgress(planStart: string, planDays: number | null, delayDays: number | null, today: string): number {
  const effective = Math.max(1, (planDays ?? 0) + (delayDays ?? 0));
  return Math.min(100, Math.max(0, Math.round((workdaysElapsed(planStart, today) / effective) * 100)));
}

export type ProgressInput = {
  status: 'todo' | 'doing' | 'done';
  planStart: string | null;
  planDays: number | null;
  delayDays: number | null;
  progressOverride: number | null;
};

/** 展示进度：已完成 = 100；手动进度优先；没有开始日期 = 0；否则按工作日推算。 */
export function displayProgress(t: ProgressInput, today: string): number {
  if (t.status === 'done') return 100;
  if (t.progressOverride !== null) return Math.min(100, Math.max(0, Math.round(t.progressOverride)));
  if (!t.planStart) return 0;
  return theoreticalProgress(t.planStart, t.planDays, t.delayDays, today);
}

/** start 到 end（都含）之间的工作日。 */
export function workdaysBetween(start: string, end: string): string[] {
  const out: string[] = [];
  const last = dayNumber(end);
  for (let d = dayNumber(start); d <= last; d++) if (!isWeekend(d)) out.push(dateOfDay(d));
  return out;
}

export type ScheduleInput = { planStart: string | null; planDays: number | null; delayDays: number | null };

/**
 * 某天是否被任务占用（push 热力图的规则）：占用 [开始日, 开始日 + max(0.5, 工期 + 延期)) 内的自然日，
 * 工期为空或 0 按半天。返回 'plan'（计划内）、'delay'（延期部分）或 null。
 */
export function coverKind(t: ScheduleInput, day: string): 'plan' | 'delay' | null {
  if (!t.planStart) return null;
  const start = dayNumber(t.planStart);
  const d = dayNumber(day);
  const plan = t.planDays || 0.5;
  const span = Math.max(0.5, plan + (t.delayDays || 0));
  if (d < start || d >= start + span) return null;
  return d < start + plan ? 'plan' : 'delay';
}

/** 每个工作日上被占用的任务数。 */
export function loadCounts(tasks: ScheduleInput[], days: string[]): number[] {
  return days.map((day) => tasks.filter((t) => coverKind(t, day) !== null).length);
}

/** 热力图色阶 0–4（push 的规则）：0 = 没有任务；其余按与最大值之比分四档。 */
export function heatLevel(count: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0) return 0;
  const r = count / Math.max(1, max);
  return r <= 0.25 ? 1 : r <= 0.5 ? 2 : r <= 0.75 ? 3 : 4;
}

export type OverviewTask = ProgressInput & {
  requirementId: string | null;
  /** 行标题：有需求时由调用方传入「编号 标题」，没有需求时为任务标题。 */
  title: string;
  flag: TaskFlag | null;
  note: string | null;
  assigneeName: string | null;
};

export type IterationOverview = {
  rowCount: number;
  countedCount: number;
  overall: number;
  expected: number;
  behind: number;
  deferred: number;
  attention: Array<{ kind: 'attention' | 'notice'; title: string; assignees: string[]; note: string }>;
};

/**
 * 迭代概览（push 的 A 方案）：任务按需求聚合为行（没有需求的按标题），行进度为各任务展示进度的平均；
 * 标了「关注」且未完成的行视为遗留下期，不计入整体进度；理论进度按迭代的工作日比例。
 */
export function iterationOverview(tasks: OverviewTask[], iteration: { startDate: string; endDate: string }, today: string): IterationOverview {
  const groups = new Map<string, OverviewTask[]>();
  for (const t of tasks) {
    const title = t.title.trim();
    if (!title) continue;
    const key = t.requirementId ?? `title:${title}`;
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  const rows = [...groups.values()].map((segs) => ({
    title: segs[0]!.title.trim(),
    progress: Math.round(segs.reduce((sum, s) => sum + displayProgress(s, today), 0) / segs.length),
    attention: segs.some((s) => s.flag === 'attention'),
    note: segs.map((s) => (s.note ?? '').trim()).find((n) => n !== '') ?? '',
    assignees: [...new Set(segs.map((s) => s.assigneeName).filter((x): x is string => !!x))],
  }));
  const counted = rows.filter((r) => !(r.attention && r.progress < 100));
  const overall = counted.length ? Math.round(counted.reduce((sum, r) => sum + r.progress, 0) / counted.length) : 0;
  const total = workdaysElapsed(iteration.startDate, iteration.endDate);
  const expected = total > 0 ? Math.min(100, Math.max(0, Math.round((workdaysElapsed(iteration.startDate, today) / total) * 100))) : 0;
  const seen = new Set<string>();
  const attention: IterationOverview['attention'] = [];
  for (const r of rows) {
    if ((!r.attention && !r.note) || seen.has(r.title)) continue;
    seen.add(r.title);
    attention.push({ kind: r.attention ? 'attention' : 'notice', title: r.title, assignees: r.assignees, note: r.note });
  }
  return {
    rowCount: rows.length,
    countedCount: counted.length,
    overall,
    expected,
    behind: Math.max(0, expected - overall),
    deferred: rows.length - counted.length,
    attention,
  };
}

/** 某个时区的当天日期（YYYY-MM-DD）。 */
export function todayInZone(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
