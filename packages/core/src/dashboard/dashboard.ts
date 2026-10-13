import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { requireProductRole, visibleProductIds } from '../access/permissions';
import { assertIsoDate } from '../dates';
import type { Db } from '../db/client';
import { iterations, products } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError } from '../errors';
import { displayKey } from '../requirements/requirements';
import { type IterationOption, loadIterationFacts, loadIterationOptions, loadReleaseFacts, loadSpecialFacts } from './delivery';
import {
  type IterationRow,
  iterationCommitment,
  type ReleaseFact,
  type ReleaseSummary,
  releaseSummary,
  type ReviewEventFact,
  type ReviewItemRow,
  type ReviewSummary,
  reviewSummary,
  specialCompletion,
  type SpecialRow,
} from './delivery-metrics';
import { loadProductFlow, orgTimeZone, type ProductFlow } from './flow';
import { addDays, type Completion, completionsOf, daysBetween, flowSummary, stuckNow, type WeekPoint, weeklySeries, zonedDate } from './metrics';
import { loadReviewEvents } from './review';

export const DASHBOARD_RANGE_DAYS = [30, 90, 180] as const;
export const DASHBOARD_MAX_DAYS = 366;

export type DashboardRange =
  | { kind: 'days'; days: (typeof DASHBOARD_RANGE_DAYS)[number] }
  | { kind: 'custom'; from: string; to: string }
  | { kind: 'iteration'; iterationId: string };
export type DashboardWindow = {
  from: string;
  to: string;
  days: number;
  previousFrom: string;
  previousTo: string;
  today: string;
  timeZone: string;
  /** 时间段结束日是否为今天：是时在制品卡片为「当前在制品」，否则为「期末在制品」（取值都是结束日结束时的数量）。 */
  endsToday: boolean;
  iteration: { id: string; name: string } | null;
};
export type MetricPair = { value: number | null; previous: number | null };
export type DashboardCards = {
  throughputPerWeek: MetricPair;
  leadTimeMedian: MetricPair;
  flowTimeMedian: MetricPair;
  wip: MetricPair;
  releaseOnTimeRate: MetricPair;
  rejectionRate: MetricPair;
};
export type StateView = { key: string; label: string; color: string };
export type ProductDashboard = {
  product: { id: string; key: string; name: string };
  window: DashboardWindow;
  iterationOptions: IterationOption[];
  cards: DashboardCards;
  completedCount: number;
  weeks: WeekPoint[];
  stuck: {
    states: Array<StateView & { count: number; avgDays: number }>;
    oldest: Array<{ id: string; displayKey: string; title: string; state: StateView; days: number }>;
  };
  iterations: IterationRow[];
  releases: ReleaseSummary;
  specials: SpecialRow[];
  review: { since: string | null; concluded: number; rejected: number; rejectionRate: number | null; items: Array<ReviewItemRow & { label: string }> };
};
export type OrgDashboard = {
  window: DashboardWindow;
  products: Array<{ id: string; key: string; name: string; cards: DashboardCards; completedCount: number }>;
};

/** 组织汇总的查看权限：所有者或管理员；用 Token 时须为全部产品范围（只读、读写均可）。 */
export function canViewOrgDashboard(actor: Actor): boolean {
  if (actor.orgRole !== 'owner' && actor.orgRole !== 'admin') return false;
  return !actor.tokenScope || actor.tokenScope.products === 'all';
}

function windowOf(from: string, to: string, today: string, timeZone: string, iteration: DashboardWindow['iteration']): DashboardWindow {
  const days = daysBetween(from, to) + 1;
  const previousTo = addDays(from, -1);
  return { from, to, days, previousFrom: addDays(previousTo, -(days - 1)), previousTo, today, timeZone, endsToday: to === today, iteration };
}

/** 解析时间段：近 N 天（结束日为今天）、自定义（最多 366 天，不晚于今天）、按迭代（本产品已开始的常规迭代，结束日不晚于今天）。 */
async function resolveWindow(tx: Tx, productId: string | null, range: DashboardRange, today: string, timeZone: string): Promise<DashboardWindow> {
  if (range.kind === 'days') {
    if (!(DASHBOARD_RANGE_DAYS as readonly number[]).includes(range.days)) throw new AppError('invalid', '时间段只能是近 30、90 或 180 天');
    return windowOf(addDays(today, -(range.days - 1)), today, today, timeZone, null);
  }
  if (range.kind === 'custom') {
    const from = assertIsoDate(range.from, '开始日期');
    const to = assertIsoDate(range.to, '结束日期');
    if (from > to) throw new AppError('invalid', '结束日期不能早于开始日期');
    if (to > today) throw new AppError('invalid', '结束日期不能晚于今天');
    if (daysBetween(from, to) + 1 > DASHBOARD_MAX_DAYS) throw new AppError('invalid', '自定义时间段不超过 366 天');
    return windowOf(from, to, today, timeZone, null);
  }
  if (!productId) throw new AppError('invalid', '组织汇总不支持按迭代查看');
  const [it] = await tx
    .select({ id: iterations.id, name: iterations.name, startDate: iterations.startDate, endDate: iterations.endDate })
    .from(iterations)
    .where(and(eq(iterations.id, range.iterationId), eq(iterations.productId, productId), eq(iterations.type, 'regular'), isNull(iterations.deletedAt)));
  if (!it) throw new AppError('not_found', '迭代不存在');
  if (it.startDate > today) throw new AppError('invalid', '迭代还没有开始');
  return windowOf(it.startDate, it.endDate < today ? it.endDate : today, today, timeZone, { id: it.id, name: it.name });
}

type Facts = { flow: ProductFlow; completions: Completion[]; releases: ReleaseFact[]; review: ReviewEventFact[]; dataStart: string | null };

async function loadFacts(tx: Tx, productId: string, timeZone: string): Promise<Facts> {
  const flow = await loadProductFlow(tx, productId, timeZone);
  let dataStart: string | null = null;
  for (const r of flow.requirements) {
    const first = r.transitions[0]!.date;
    if (dataStart === null || first < dataStart) dataStart = first;
  }
  return {
    flow,
    completions: completionsOf(flow.requirements, flow.categoryOf),
    releases: await loadReleaseFacts(tx, productId),
    review: await loadReviewEvents(tx, productId, new Set(flow.meta.keys())),
    dataStart,
  };
}

type Summary = { cards: DashboardCards; completedCount: number; releases: ReleaseSummary; review: ReviewSummary };

/**
 * 六个关键数字与上一个同长度时间段；本期的版本与评审汇总一并返回，产品看板的对应区块直接复用。
 * 产品在时间段结束时还没有任何需求时，吞吐量与在制品为 null；上期早于产品数据起点时，流动类指标的上期为 null（不和 0 比较）。
 */
function summarize(f: Facts, w: DashboardWindow): Summary {
  const { requirements: reqs, categoryOf } = f.flow;
  const cur = flowSummary(reqs, f.completions, categoryOf, w.from, w.to);
  const hasCurrent = f.dataStart !== null && f.dataStart <= w.to;
  const prev = f.dataStart !== null && f.dataStart <= w.previousTo ? flowSummary(reqs, f.completions, categoryOf, w.previousFrom, w.previousTo) : null;
  const releases = releaseSummary(f.releases, w.from, w.to, w.today, w.timeZone);
  const review = reviewSummary(f.review, w.from, w.to, w.timeZone);
  return {
    completedCount: cur.completed,
    releases,
    review,
    cards: {
      throughputPerWeek: { value: hasCurrent ? cur.throughputPerWeek : null, previous: prev?.throughputPerWeek ?? null },
      leadTimeMedian: { value: cur.leadMedian, previous: prev?.leadMedian ?? null },
      flowTimeMedian: { value: cur.flowMedian, previous: prev?.flowMedian ?? null },
      wip: { value: hasCurrent ? cur.wip : null, previous: prev?.wip ?? null },
      releaseOnTimeRate: { value: releases.onTimeRate, previous: releaseSummary(f.releases, w.previousFrom, w.previousTo, w.today, w.timeZone).onTimeRate },
      rejectionRate: { value: review.rejectionRate, previous: reviewSummary(f.review, w.previousFrom, w.previousTo, w.timeZone).rejectionRate },
    },
  };
}

/** 产品看板：能看到该产品的成员都可以查看（含访客被授权的产品、只读 Token）；看不到时与不存在一样返回 404。 */
export async function getProductDashboard(db: Db, actor: Actor, productId: string, input: { range: DashboardRange; now?: Date }): Promise<ProductDashboard> {
  return withOrg(db, actor.orgId, async (tx) => {
    await requireProductRole(tx, actor, productId, 'viewer');
    const now = input.now ?? new Date();
    const timeZone = await orgTimeZone(tx, actor.orgId);
    const today = zonedDate(now, timeZone);
    const window = await resolveWindow(tx, productId, input.range, today, timeZone);
    const [product] = await tx.select({ id: products.id, key: products.key, name: products.name }).from(products).where(eq(products.id, productId));
    const facts = await loadFacts(tx, productId, timeZone);
    const { flow } = facts;
    const stateMeta = new Map(flow.states.map((s) => [s.key, s]));
    const stateView = (key: string): StateView => ({ key, label: stateMeta.get(key)?.label ?? key, color: stateMeta.get(key)?.color ?? '#8a9199' });
    const stuck = stuckNow(flow.requirements, flow.categoryOf, now);
    const byId = new Map(flow.requirements.map((r) => [r.id, r]));
    const { cards, completedCount, releases, review } = summarize(facts, window);
    const itemOrder = new Map(flow.checkItems.map((c, i) => [c.key, i]));
    const itemLabel = new Map(flow.checkItems.map((c) => [c.key, c.label]));
    return {
      product: product!,
      window,
      iterationOptions: await loadIterationOptions(tx, productId, today),
      cards,
      completedCount,
      weeks: weeklySeries(flow.requirements, facts.completions, flow.categoryOf, window.from, window.to),
      stuck: {
        states: stuck.states.map((s) => ({ ...stateView(s.key), count: s.count, avgDays: s.avgDays })),
        oldest: stuck.oldest.map((o) => {
          const m = flow.meta.get(o.id)!;
          return { id: o.id, displayKey: displayKey(flow.productKey, m.number), title: m.title, state: stateView(o.stateKey), days: o.days };
        }),
      },
      iterations: (await loadIterationFacts(tx, productId, flow, window.from, window.to)).map((it) => iterationCommitment(it, byId, flow.categoryOf, today)),
      releases,
      specials: (await loadSpecialFacts(tx, flow, window.from, window.to)).map((s) => specialCompletion(s, flow.categoryOf)),
      review: {
        ...review,
        items: review.items
          .map((i) => ({ ...i, label: itemLabel.get(i.itemKey) ?? i.itemKey }))
          .sort((a, b) => (itemOrder.get(a.itemKey) ?? Number.MAX_SAFE_INTEGER) - (itemOrder.get(b.itemKey) ?? Number.MAX_SAFE_INTEGER) || a.itemKey.localeCompare(b.itemKey)),
      },
    };
  });
}

/** 组织汇总：仅组织管理员；每个可见产品一行（按编号前缀排序），列出六个关键数字与上期对比。不支持按迭代。 */
export async function getOrgDashboard(db: Db, actor: Actor, input: { range: DashboardRange; now?: Date }): Promise<OrgDashboard> {
  if (!canViewOrgDashboard(actor)) throw new AppError('forbidden', '需要组织管理员权限');
  if (input.range.kind === 'iteration') throw new AppError('invalid', '组织汇总不支持按迭代查看');
  return withOrg(db, actor.orgId, async (tx) => {
    const timeZone = await orgTimeZone(tx, actor.orgId);
    const today = zonedDate(input.now ?? new Date(), timeZone);
    const window = await resolveWindow(tx, null, input.range, today, timeZone);
    const visible = await visibleProductIds(tx, actor);
    const rows =
      visible.size > 0
        ? await tx
            .select({ id: products.id, key: products.key, name: products.name })
            .from(products)
            .where(and(inArray(products.id, [...visible]), isNull(products.deletedAt)))
            .orderBy(asc(products.key))
        : [];
    const out: OrgDashboard['products'] = [];
    for (const p of rows) {
      const { cards, completedCount } = summarize(await loadFacts(tx, p.id, timeZone), window);
      out.push({ ...p, cards, completedCount });
    }
    return { window, products: out };
  });
}
