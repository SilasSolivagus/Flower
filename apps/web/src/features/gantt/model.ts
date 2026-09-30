import { coverKind, dateOfDay, dayNumber, heatLevel, loadCounts, workdaysBetween } from '@flower/core/schedule';
import type { MemberTask, Task } from '@/lib/types';

export type ParsedNumber = { ok: true; value: number | null } | { ok: false; message: string };

/** 工期、延期输入：空 = 未填；以半天为单位，范围 min–365。提示文字与服务端校验一致。 */
export function parseHalfDays(text: string, min: number, label: '工期' | '延期'): ParsedNumber {
  const s = text.trim();
  if (!s) return { ok: true, value: null };
  const n = Number(s);
  if (!Number.isFinite(n) || n < min || n > 365 || !Number.isInteger(n * 2)) return { ok: false, message: `${label}以半天为单位，范围 ${min}–365 天` };
  return { ok: true, value: n };
}

/** 手动进度输入：空 = 按工期推算；否则为 0–100 的整数。 */
export function parseProgress(text: string): ParsedNumber {
  const s = text.trim();
  if (!s) return { ok: true, value: null };
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0 || n > 100) return { ok: false, message: '进度应为 0–100 的整数' };
  return { ok: true, value: n };
}

export type HeatRow = { id: string; name: string; counts: number[] };

/** 热力图的行：每个负责人一行（按姓名排序），列为工作日，值为当天被占用的任务数；未指派的任务不计。 */
export function heatRows(tasks: Array<Pick<Task, 'assignee' | 'planStart' | 'planDays' | 'delayDays'>>, days: string[]): { rows: HeatRow[]; max: number } {
  const byPerson = new Map<string, { name: string; tasks: typeof tasks }>();
  for (const t of tasks) {
    if (!t.assignee) continue;
    const person = byPerson.get(t.assignee.id) ?? { name: t.assignee.displayName, tasks: [] };
    person.tasks.push(t);
    byPerson.set(t.assignee.id, person);
  }
  const rows = [...byPerson.entries()]
    .map(([id, p]) => ({ id, name: p.name, counts: loadCounts(p.tasks, days) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  return { rows, max: Math.max(1, ...rows.flatMap((r) => r.counts)) };
}

/** 热力图 5 档底色，对应 heatLevel 的 0–4。 */
export const HEAT_CLASSES = ['bg-muted', 'bg-primary/20', 'bg-primary/40', 'bg-primary/65', 'bg-primary'] as const;
export const heatClass = (count: number, max: number): string => HEAT_CLASSES[heatLevel(count, max)];

/** 时间轴一行在各工作日上的格子：计划内、延期或空。 */
export function timelineCells(t: Pick<Task, 'planStart' | 'planDays' | 'delayDays'>, days: string[]): Array<'plan' | 'delay' | null> {
  return days.map((d) => coverKind(t, d));
}

/** 列头日期：M/D。 */
export const shortDate = (date: string): string => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;

/** 从今天起若干周内的工作日（人员负载页的负载条）。 */
export function upcomingWorkdays(today: string, weeks: number): string[] {
  return workdaysBetween(today, dateOfDay(dayNumber(today) + weeks * 7 - 1));
}

export type IterationGroup = { key: string; iteration: MemberTask['iteration']; tasks: MemberTask[] };

/** 人员负载页：按迭代分组，迭代按开始日期倒序，不在迭代中的任务放最后。 */
export function groupByIteration(tasks: MemberTask[]): IterationGroup[] {
  const groups = new Map<string, IterationGroup>();
  for (const t of tasks) {
    const key = t.iteration?.id ?? 'none';
    const group = groups.get(key) ?? { key, iteration: t.iteration, tasks: [] };
    group.tasks.push(t);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => {
    if (!a.iteration) return 1;
    if (!b.iteration) return -1;
    return b.iteration.startDate.localeCompare(a.iteration.startDate);
  });
}
