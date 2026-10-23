import { and, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { visibleProductIds } from '../access/permissions';
import type { Db } from '../db/client';
import { blockers, type IterationMilestone, iterations, products, requirements, tasks } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { overviewTaskOf } from '../tasks/queries';
import { dayNumber, iterationOverview, type IterationOverview, todayInZone } from '../tasks/schedule';
import { hydrateTasks } from '../tasks/tasks';
import { stateInfoByProduct, stateOf } from './iterations';

/**
 * 「此刻」的今天。产品 PC-3：写死 Asia/Shanghai 自然日，不跟组织可配时区，也不跟浏览器时区。
 * 选择规则与概览用同一个日期字符串，避免选中了但概览按另一天计算。
 */
export const NOW_ITERATION_TIME_ZONE = 'Asia/Shanghai';

/** 候选迭代进响应的上限。再多按产品 key 排序截断；名称与已返回条目一起留下。 */
export const NOW_ITERATION_CAP = 30;
/** 关注/周知只带前几条，其余用 attentionTruncated 标明。 */
export const NOW_ATTENTION_CAP = 5;
/** 卡面上「本迭代我的未完成任务」最多列几条；myTaskCount 仍是全量。 */
export const NOW_TASK_CAP = 5;

const SPECIAL_SORT_KEY = '\uffff';

export function nowIterationToday(now: Date = new Date()): string {
  return todayInZone(NOW_ITERATION_TIME_ZONE, now);
}

export type NowIterationPresence = 'none' | 'no_now' | 'present' | 'unscoped';

export type NowIterationProduct = { id: string; key: string; name: string };

export type NowIterationPlanningHint = {
  id: string;
  name: string;
  product: NowIterationProduct | null;
};

export type NowIterationTaskRef = {
  id: string;
  displayKey: string;
  title: string;
  requirement: { displayKey: string; title: string } | null;
};

export type NowIterationCard = {
  id: string;
  name: string;
  product: NowIterationProduct | null;
  type: 'regular' | 'special';
  status: 'active';
  startDate: string;
  endDate: string;
  baselineEndDate: string | null;
  milestones: IterationMilestone[];
  milestoneSummary: {
    total: number;
    past: number;
    upcoming: number;
    next: { label: string; date: string } | null;
  };
  requirementCount: number;
  doneCount: number;
  overview: {
    overall: number;
    expected: number;
    behind: number;
    deferred: number;
    rowCount: number;
    countedCount: number;
    attention: IterationOverview['attention'];
    attentionTruncated: boolean;
    /** 与甘特 overviewIsHollow 同一口径：没有任务，或整体/理论/落后/遗留四项都是 0。 */
    isHollow: boolean;
    taskCount: number;
  } | null;
  myTaskCount: number;
  myTasks: NowIterationTaskRef[];
  blockerCount: number;
};

export type NowIterationBlock = {
  nowIterations: NowIterationCard[];
  nowIterationPresence: Exclude<NowIterationPresence, 'unscoped'>;
  planningHint: NowIterationPlanningHint | null;
};

type IterRow = typeof iterations.$inferSelect;
type TaskRow = typeof tasks.$inferSelect;

function hollow(overview: Pick<IterationOverview, 'overall' | 'expected' | 'behind' | 'deferred'>, taskCount: number): boolean {
  return taskCount === 0 || (overview.overall === 0 && overview.expected === 0 && overview.behind === 0 && overview.deferred === 0);
}

function milestoneSummary(list: IterationMilestone[], today: string): NowIterationCard['milestoneSummary'] {
  const sorted = [...list].sort((a, b) => a.date.localeCompare(b.date));
  const past = sorted.filter((m) => m.date < today).length;
  return {
    total: sorted.length,
    past,
    upcoming: sorted.length - past,
    next: sorted.find((m) => m.date >= today) ?? null,
  };
}

function productKeyOf(row: IterRow, prods: Map<string, NowIterationProduct>): string {
  if (!row.productId) return SPECIAL_SORT_KEY;
  return prods.get(row.productId)?.key ?? '';
}

/** 产品 key 升序，同产品开始日倒序，再按名称。专项没有产品，排在具名产品之后。 */
function compareNow(a: IterRow, b: IterRow, prods: Map<string, NowIterationProduct>): number {
  const ka = productKeyOf(a, prods);
  const kb = productKeyOf(b, prods);
  if (ka !== kb) return ka < kb ? -1 : 1;
  if (a.startDate !== b.startDate) return a.startDate < b.startDate ? 1 : -1;
  return a.name.localeCompare(b.name, 'zh-CN');
}

function pickPlanning(rows: IterRow[], today: string): IterRow | null {
  const todayN = dayNumber(today);
  const planning = rows.filter((r) => r.status === 'planning');
  planning.sort((a, b) => {
    const da = Math.abs(dayNumber(a.startDate) - todayN);
    const db = Math.abs(dayNumber(b.startDate) - todayN);
    if (da !== db) return da - db;
    if (a.startDate !== b.startDate) return a.startDate < b.startDate ? 1 : -1;
    return a.name.localeCompare(b.name, 'zh-CN');
  });
  return planning[0] ?? null;
}

async function productMap(tx: Tx, ids: string[]): Promise<Map<string, NowIterationProduct>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await tx.select({ id: products.id, key: products.key, name: products.name }).from(products).where(inArray(products.id, unique));
  return new Map(rows.map((p) => [p.id, p]));
}

function productOf(row: IterRow, prods: Map<string, NowIterationProduct>): NowIterationProduct | null {
  return row.productId ? (prods.get(row.productId) ?? null) : null;
}

const emptyBlock = (presence: NowIterationBlock['nowIterationPresence'], planningHint: NowIterationPlanningHint | null = null): NowIterationBlock => ({
  nowIterations: [],
  nowIterationPresence: presence,
  planningHint,
});

/**
 * 当前组织里「此刻迭代」：active，且 startDate ≤ 上海今天 ≤ endDate（闭区间）。
 * 常规迭代必须落在 visibleProductIds 里；专项仅当操作者至少能看到一个产品。
 * 不可见产品的需求、任务、阻塞都不进入计数和概览。
 */
export async function loadNowIterations(db: Db, actor: Actor, opts: { now?: Date } = {}): Promise<NowIterationBlock> {
  const today = nowIterationToday(opts.now);
  return withOrg(db, actor.orgId, async (tx) => {
    const visible = await visibleProductIds(tx, actor);
    if (visible.size === 0) return emptyBlock('none');

    const alive = and(isNull(iterations.deletedAt), or(inArray(iterations.productId, [...visible]), eq(iterations.type, 'special')));
    const nowRows = await tx
      .select()
      .from(iterations)
      .where(and(alive, eq(iterations.status, 'active'), lte(iterations.startDate, today), gte(iterations.endDate, today)));

    if (nowRows.length === 0) {
      const [any] = await tx.select({ id: iterations.id }).from(iterations).where(alive).limit(1);
      if (!any) return emptyBlock('none');
      const planningRows = await tx.select().from(iterations).where(and(alive, eq(iterations.status, 'planning')));
      const picked = pickPlanning(planningRows, today);
      if (!picked) return emptyBlock('no_now');
      const prods = await productMap(tx, picked.productId ? [picked.productId] : []);
      return emptyBlock('no_now', { id: picked.id, name: picked.name, product: productOf(picked, prods) });
    }

    const prods = await productMap(
      tx,
      nowRows.flatMap((r) => (r.productId ? [r.productId] : [])),
    );
    const capped = [...nowRows].sort((a, b) => compareNow(a, b, prods)).slice(0, NOW_ITERATION_CAP);
    const ids = capped.map((r) => r.id);
    const visibleIds = [...visible];

    const reqs = await tx
      .select({
        id: requirements.id,
        iterationId: requirements.iterationId,
        productId: requirements.productId,
        stateKey: requirements.stateKey,
      })
      .from(requirements)
      .where(and(inArray(requirements.iterationId, ids), isNull(requirements.deletedAt), inArray(requirements.productId, visibleIds)));
    const info = await stateInfoByProduct(tx, reqs.map((r) => r.productId));

    const reqIds = reqs.map((r) => r.id);
    const blockerRows = reqIds.length
      ? await tx
          .select({ requirementId: blockers.requirementId, n: sql<number>`count(*)::int` })
          .from(blockers)
          .where(and(inArray(blockers.requirementId, reqIds), eq(blockers.status, 'active')))
          .groupBy(blockers.requirementId)
      : [];
    const blockerByReq = new Map(blockerRows.flatMap((c) => (c.requirementId ? [[c.requirementId, c.n] as const] : [])));

    const taskRows = await tx
      .select()
      .from(tasks)
      .where(and(inArray(tasks.iterationId, ids), inArray(tasks.productId, visibleIds)));
    const views = await hydrateTasks(tx, actor, taskRows, today);
    const grouped = new Map<string, Array<{ row: TaskRow; view: (typeof views)[number] }>>();
    taskRows.forEach((row, i) => {
      if (!row.iterationId) return;
      const list = grouped.get(row.iterationId) ?? [];
      list.push({ row, view: views[i]! });
      grouped.set(row.iterationId, list);
    });

    const cards: NowIterationCard[] = capped.map((row) => {
      const mineReqs = reqs.filter((r) => r.iterationId === row.id);
      const group = grouped.get(row.id) ?? [];
      const raw = iterationOverview(
        group.map((g) => overviewTaskOf(g.view)),
        { startDate: row.startDate, endDate: row.endDate },
        today,
      );
      const taskCount = group.length;
      const mine = group
        .filter((g) => g.row.assigneeMemberId === actor.memberId && g.row.status !== 'done')
        .sort((a, b) => (a.row.planStart ?? '9999-12-31').localeCompare(b.row.planStart ?? '9999-12-31') || a.view.displayKey.localeCompare(b.view.displayKey, 'zh-CN', { numeric: true }));
      return {
        id: row.id,
        name: row.name,
        product: productOf(row, prods),
        type: row.type,
        status: 'active',
        startDate: row.startDate,
        endDate: row.endDate,
        baselineEndDate: row.baselineEndDate,
        milestones: row.milestones,
        milestoneSummary: milestoneSummary(row.milestones, today),
        requirementCount: mineReqs.length,
        doneCount: mineReqs.filter((r) => stateOf(info, r.productId, r.stateKey).category === 'completed').length,
        overview: {
          overall: raw.overall,
          expected: raw.expected,
          behind: raw.behind,
          deferred: raw.deferred,
          rowCount: raw.rowCount,
          countedCount: raw.countedCount,
          attention: raw.attention.slice(0, NOW_ATTENTION_CAP),
          attentionTruncated: raw.attention.length > NOW_ATTENTION_CAP,
          isHollow: hollow(raw, taskCount),
          taskCount,
        },
        myTaskCount: mine.length,
        myTasks: mine.slice(0, NOW_TASK_CAP).map((g) => ({
          id: g.view.id,
          displayKey: g.view.displayKey,
          title: g.view.title,
          requirement: g.view.requirement ? { displayKey: g.view.requirement.displayKey, title: g.view.requirement.title } : null,
        })),
        blockerCount: mineReqs.reduce((sum, r) => sum + (blockerByReq.get(r.id) ?? 0), 0),
      };
    });

    return { nowIterations: cards, nowIterationPresence: 'present', planningHint: null };
  });
}
