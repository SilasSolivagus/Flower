/**
 * 看板的交付与评审指标（P3-B2）：版本按期达成、迭代承诺完成、专项完成、评审效率与驳回率。
 * 纯函数，输入由 dashboard/delivery.ts 与 dashboard/review.ts 从数据库读出，单测直接构造。
 */
import { type CategoryOf, daysBetween, elapsedDays, type FlowRequirement, quantile, ratio, round1, stateAtEndOf, zonedDate } from './metrics';

export type ReleaseFact = {
  id: string;
  versionName: string;
  status: 'planned' | 'released';
  plannedDate: string | null;
  baselineDate: string | null;
  releasedAt: Date | null;
  /** 所属迭代（未删除）的结束日；没有所属迭代时为 null。 */
  iterationEndDate: string | null;
};
export type DueSource = 'baseline' | 'planned' | 'iteration';
export type ReleaseRow = {
  id: string;
  versionName: string;
  status: 'planned' | 'released';
  plannedDate: string | null;
  dueDate: string | null;
  dueSource: DueSource | null;
  releasedOn: string | null;
  onTime: boolean | null;
  overdueDays: number | null;
};
export type ReleaseSummary = { released: number; evaluated: number; onTime: number; onTimeRate: number | null; rows: ReleaseRow[] };

function dueOf(primary: string | null, source: DueSource, iterationEnd: string | null): { dueDate: string | null; dueSource: DueSource | null } {
  if (primary) return { dueDate: primary, dueSource: source };
  if (iterationEnd) return { dueDate: iterationEnd, dueSource: 'iteration' };
  return { dueDate: null, dueSource: null };
}

/**
 * 版本按期：时间段内（发布日按组织时区）已发布的版本，到期日为基线日期，没有时用所属迭代结束日；
 * 两者都没有的不进分母。计划中的版本全部列出，到期日为计划日期（没有时用所属迭代结束日），逾期天数算到今天。
 * 行顺序：计划中的按到期日升序在前，已发布的按发布日倒序在后。
 */
export function releaseSummary(list: ReleaseFact[], from: string, to: string, today: string, timeZone: string): ReleaseSummary {
  const released: ReleaseRow[] = [];
  const pending: ReleaseRow[] = [];
  for (const r of list) {
    const base = { id: r.id, versionName: r.versionName, status: r.status, plannedDate: r.plannedDate };
    if (r.status === 'released') {
      if (!r.releasedAt) continue;
      const releasedOn = zonedDate(r.releasedAt, timeZone);
      if (releasedOn < from || releasedOn > to) continue;
      const due = dueOf(r.baselineDate, 'baseline', r.iterationEndDate);
      released.push({
        ...base,
        ...due,
        releasedOn,
        onTime: due.dueDate === null ? null : releasedOn <= due.dueDate,
        overdueDays: due.dueDate === null ? null : Math.max(0, daysBetween(due.dueDate, releasedOn)),
      });
    } else {
      const due = dueOf(r.plannedDate, 'planned', r.iterationEndDate);
      pending.push({ ...base, ...due, releasedOn: null, onTime: null, overdueDays: due.dueDate === null ? null : Math.max(0, daysBetween(due.dueDate, today)) });
    }
  }
  pending.sort((a, b) => (a.dueDate ?? '9999-12-31').localeCompare(b.dueDate ?? '9999-12-31') || a.versionName.localeCompare(b.versionName));
  released.sort((a, b) => b.releasedOn!.localeCompare(a.releasedOn!) || a.versionName.localeCompare(b.versionName));
  const evaluated = released.filter((r) => r.onTime !== null);
  const onTime = evaluated.filter((r) => r.onTime).length;
  return { released: released.length, evaluated: evaluated.length, onTime, onTimeRate: ratio(onTime, evaluated.length), rows: [...pending, ...released] };
}

export type IterationFact = {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  status: 'active' | 'done';
  /** 是否取过承诺范围快照（迭代在 Flower 里开始时取；迁移来的旧迭代没有）。快照可以是空的。 */
  snapshotTaken: boolean;
  /** 承诺范围快照里的需求（可能含已删除的）。 */
  committedIds: string[];
  /** 当前在迭代里的未删除需求。 */
  currentIds: string[];
};
export type IterationReason = '没有承诺范围快照' | '承诺范围为空';
export type IterationRow = {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  status: 'active' | 'done';
  cutoff: string;
  hasSnapshot: boolean;
  /** 没有承诺完成率的原因：没取过快照，或快照里没有（未删除的）需求；其他情况为 null。 */
  reason: IterationReason | null;
  committed: number;
  completed: number;
  canceled: number;
  rate: number | null;
  added: number;
  removed: number;
};

/**
 * 迭代承诺完成率：快照内未删除的需求在截止日（已完成的迭代为结束日，进行中的为今天）结束时处于完成类的比例，
 * 已取消的不进分母；没有快照时为 null；快照为空或其中的需求都已删除时，rate 同为 null，reason 为「承诺范围为空」。中途加入 = 当前在迭代里但不在快照里；移出 = 在快照里、当前不在迭代里。
 */
export function iterationCommitment(it: IterationFact, byId: Map<string, FlowRequirement>, categoryOf: CategoryOf, today: string): IterationRow {
  const cutoff = it.status === 'active' ? today : it.endDate;
  const committedSet = new Set(it.committedIds);
  const current = new Set(it.currentIds);
  const committed = it.committedIds.map((id) => byId.get(id)).filter((r): r is FlowRequirement => r !== undefined);
  let completed = 0;
  let canceled = 0;
  for (const r of committed) {
    const s = stateAtEndOf(r, cutoff);
    const c = s === null ? null : categoryOf(s);
    if (c === 'completed') completed++;
    else if (c === 'canceled') canceled++;
  }
  const reason: IterationReason | null = !it.snapshotTaken ? '没有承诺范围快照' : committed.length === 0 ? '承诺范围为空' : null;
  return {
    id: it.id,
    name: it.name,
    startDate: it.startDate,
    endDate: it.endDate,
    status: it.status,
    cutoff,
    hasSnapshot: it.snapshotTaken,
    reason,
    committed: committed.length,
    completed,
    canceled,
    rate: it.snapshotTaken ? ratio(completed, committed.length - canceled) : null,
    added: it.currentIds.filter((id) => !committedSet.has(id)).length,
    removed: committed.filter((r) => !current.has(r.id)).length,
  };
}

export type SpecialStatus = 'planning' | 'active' | 'done' | 'canceled';
export type SpecialFact = { id: string; name: string; startDate: string; endDate: string; status: SpecialStatus; stateKeys: string[] };
export type SpecialRow = { id: string; name: string; startDate: string; endDate: string; status: SpecialStatus; total: number; completed: number; canceled: number; rate: number | null };

/** 专项完成率：完成数 ÷（总数 − 已取消数）；stateKeys 只含本产品未删除的需求。 */
export function specialCompletion(s: SpecialFact, categoryOf: CategoryOf): SpecialRow {
  const cats = s.stateKeys.map(categoryOf);
  const completed = cats.filter((c) => c === 'completed').length;
  const canceled = cats.filter((c) => c === 'canceled').length;
  return { id: s.id, name: s.name, startDate: s.startDate, endDate: s.endDate, status: s.status, total: cats.length, completed, canceled, rate: ratio(completed, cats.length - canceled) };
}

export type ReviewEventFact = {
  subjectType: string;
  subjectId: string;
  itemKey: string;
  type: string;
  /** 本次事件把检查项状态改成的值；没有改变状态时为 null。 */
  newState: string | null;
  /** 签字事件的结论（passed / rejected）；普通检查项为 null。 */
  decision: string | null;
  at: Date;
};
export type ReviewItemRow = { itemKey: string; passed: number; medianDays: number | null; concluded: number; rejected: number; rejectionRate: number | null };
export type ReviewSummary = { since: string | null; concluded: number; rejected: number; rejectionRate: number | null; items: ReviewItemRow[] };

/**
 * 评审效率与驳回率，按（对象、检查项）分组计算，再按检查项汇总：
 * - 开始评审：第一条离开「未开始」或第一次签字的事件；评审天数：开始到最后一次变为「通过」（最终状态须为通过），按通过日落在时间段内统计；
 * - 有结论：时间段内有变为通过或驳回、或签字结论为驳回的事件；驳回过：其中出现过驳回（先驳回后通过的也算）。
 * 统计起点为最早一条事件的日期。
 */
export function reviewSummary(events: ReviewEventFact[], from: string, to: string, timeZone: string): ReviewSummary {
  const sorted = [...events].sort((a, b) => a.at.getTime() - b.at.getTime());
  const groups = new Map<string, ReviewEventFact[]>();
  for (const e of sorted) {
    const key = `${e.subjectType}:${e.subjectId}:${e.itemKey}`;
    const list = groups.get(key);
    if (list) list.push(e);
    else groups.set(key, [e]);
  }
  const inWindow = (at: Date) => {
    const d = zonedDate(at, timeZone);
    return d >= from && d <= to;
  };
  const acc = new Map<string, { days: number[]; concluded: number; rejected: number }>();
  for (const list of groups.values()) {
    let start: Date | null = null;
    let passedAt: Date | null = null;
    let finalState: string | null = null;
    let concluded = false;
    let rejected = false;
    for (const e of list) {
      if (start === null && (e.type === 'check_item.signed' || (e.newState !== null && e.newState !== 'not_started'))) start = e.at;
      if (e.newState !== null) {
        finalState = e.newState;
        if (e.newState === 'passed') passedAt = e.at;
      }
      const rejectedHere = e.newState === 'rejected' || e.decision === 'rejected';
      if (inWindow(e.at) && (rejectedHere || e.newState === 'passed')) {
        concluded = true;
        if (rejectedHere) rejected = true;
      }
    }
    const itemKey = list[0]!.itemKey;
    const a = acc.get(itemKey) ?? { days: [], concluded: 0, rejected: 0 };
    if (finalState === 'passed' && passedAt && start && inWindow(passedAt)) a.days.push(elapsedDays(start, passedAt));
    if (concluded) a.concluded++;
    if (rejected) a.rejected++;
    if (a.days.length > 0 || a.concluded > 0) acc.set(itemKey, a);
  }
  const items = [...acc.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([itemKey, a]) => ({
      itemKey,
      passed: a.days.length,
      medianDays: round1(quantile(a.days, 0.5)),
      concluded: a.concluded,
      rejected: a.rejected,
      rejectionRate: ratio(a.rejected, a.concluded),
    }));
  const concluded = items.reduce((n, i) => n + i.concluded, 0);
  const rejected = items.reduce((n, i) => n + i.rejected, 0);
  return { since: sorted.length > 0 ? zonedDate(sorted[0]!.at, timeZone) : null, concluded, rejected, rejectionRate: ratio(rejected, concluded), items };
}
