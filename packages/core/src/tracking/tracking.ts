/**
 * 跟进列表（P3-C1）：在 withOrg 中按可见产品读出全部在手的需求与工作项，算好停留、在制、老化与无进展。
 * 四个页签（全部在手、任务老化、按阶段看板、按产品经理）由前端从同一份结果派生。
 * 看不到的产品的需求与工作项不出现在结果里；不关联产品的工作项只给非访客成员（Token 须为全部产品范围）。
 */
import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { atLeast, productRoleOf, visibleProductIds } from '../access/permissions';
import { orgTimeZone } from '../dashboard/flow';
import { addDays, zonedDate } from '../dashboard/metrics';
import type { Db } from '../db/client';
import {
  blockers,
  domainEvents,
  fieldDefinitions,
  fieldOptions,
  fieldValues,
  organizations,
  products,
  progressUpdates,
  requirements,
  stateTransitions,
  workflowVersions,
  workItems,
} from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor, ProductRole } from '../domain-types';
import type { WorkflowBody } from '../definitions/workflow-schema';
import { workItemDisplayKey } from '../links/syntax';
import { memberNames } from '../requirements/context';
import { displayKey, type MemberRef, type OptionRef } from '../requirements/requirements';
import { canEditUnlinked, canViewUnlinked, canWriteUnlinked } from './access';
import { activeDays, type AgingLevel, agingLevel, CLOSED_CATEGORIES, isStale, type PauseEvent, pauseIntervals, type TrackingSettings, trackingSettingsOf } from './aging';
import { WORK_ITEM_STATUS_LABELS, type WorkItemStatus } from './work-items';

/** 「含最近完成」往回看的天数。 */
export const RECENT_DONE_DAYS = 30;

const PAUSE_TYPES = ['requirement.paused', 'requirement.resumed', 'work_item.paused', 'work_item.resumed'];
const WORK_ITEM_COLOR: Record<WorkItemStatus, string> = { active: '#f59e0b', done: '#10b981', canceled: '#9ca3af' };
const WORK_ITEM_CATEGORY: Record<WorkItemStatus, string> = { active: 'started', done: 'completed', canceled: 'canceled' };

export type TrackingFilter = { productId?: string; ownerId?: string; typeOptionId?: string; paused?: boolean; blocked?: boolean; includeDone?: boolean };
export type TrackingStage = { key: string; label: string; color: string; category: string };
export type TrackingItem = {
  kind: 'requirement' | 'work_item';
  id: string;
  displayKey: string;
  title: string;
  product: { id: string; key: string; name: string } | null;
  owner: MemberRef | null;
  /** 需求为「类型」，工作项为「工作类型」。 */
  type: OptionRef | null;
  /** 需求的优先级；工作项为 null。 */
  priority: OptionRef | null;
  /** 需求为流程状态；工作项为进行中、已完成、已取消。 */
  stage: TrackingStage;
  paused: { at: Date; reason: string } | null;
  /** 本阶段停留天数（扣除暂停）：需求从进入当前状态起，工作项从启动日期起。 */
  stageDays: number;
  /** 在制天数（扣除暂停）：需求从加入跟进起，工作项从启动日期起；已完成的算到完成那天。 */
  wipDays: number;
  aging: AgingLevel;
  /** 超过阈值天数没有进展记录（没有进展时按加入跟进时间，工作项按创建时间）。 */
  stale: boolean;
  /** 启动日期：需求为加入跟进的日期，工作项为启动日期（没有时为创建日期）。 */
  startedOn: string;
  /** 进入当前阶段的日期：需求为进入当前状态的日期，工作项同启动日期。 */
  stageEnteredOn: string;
  blockers: { count: number; first: string | null };
  latest: { body: string; nextStep: string | null; follower: MemberRef | null; createdAt: Date } | null;
  expectedDate: string | null;
  /** 实际上线（完成）日期；未完成时为 null。 */
  doneOn: string | null;
  done: boolean;
  /** 当前用户能否写进展；写进展时能否顺手改预计日期。 */
  canWrite: boolean;
  canEditDate: boolean;
};
export type TrackingProduct = { id: string; key: string; name: string; states: Array<TrackingStage & { order: number }> };
export type TrackingList = {
  today: string;
  timeZone: string;
  settings: TrackingSettings;
  /** 可见产品与其流程状态（按产品编号排序），用于产品筛选与按阶段看板。 */
  products: TrackingProduct[];
  /** 筛选候选：在手条目的负责人（不受负责人、类型、暂停、阻塞筛选影响）。 */
  owners: MemberRef[];
  /** 筛选候选：「类型」与「工作类型」的选项。 */
  typeOptions: OptionRef[];
  items: TrackingItem[];
};

type ReqRow = typeof requirements.$inferSelect;
type StateMeta = Map<string, Map<string, TrackingStage>>;

async function pausesTx(tx: Tx, ids: string[]): Promise<Map<string, PauseEvent[]>> {
  const out = new Map<string, PauseEvent[]>();
  if (ids.length === 0) return out;
  const rows = await tx
    .select({ subjectId: domainEvents.subjectId, type: domainEvents.type, at: domainEvents.occurredAt })
    .from(domainEvents)
    .where(and(inArray(domainEvents.type, PAUSE_TYPES), inArray(domainEvents.subjectId, ids)));
  for (const r of rows) out.set(r.subjectId, [...(out.get(r.subjectId) ?? []), { kind: r.type.endsWith('.paused') ? 'paused' : 'resumed', at: r.at }]);
  return out;
}

/** 每个对象最新一条未删除的进展（跟进列表与工作台共用）。 */
export async function latestProgressTx(tx: Tx, reqIds: string[], wiIds: string[]): Promise<Map<string, typeof progressUpdates.$inferSelect>> {
  if (reqIds.length + wiIds.length === 0) return new Map();
  const rows = await tx
    .selectDistinctOn([progressUpdates.requirementId, progressUpdates.workItemId])
    .from(progressUpdates)
    .where(and(isNull(progressUpdates.deletedAt), or(inArray(progressUpdates.requirementId, reqIds), inArray(progressUpdates.workItemId, wiIds))))
    .orderBy(progressUpdates.requirementId, progressUpdates.workItemId, desc(progressUpdates.createdAt), desc(progressUpdates.id));
  return new Map(rows.map((r) => [(r.requirementId ?? r.workItemId)!, r]));
}

/** 进行中的阻塞项描述（按创建时间）。 */
async function activeBlockersTx(tx: Tx, reqIds: string[], wiIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (reqIds.length + wiIds.length === 0) return out;
  const rows = await tx
    .select({ requirementId: blockers.requirementId, workItemId: blockers.workItemId, description: blockers.description })
    .from(blockers)
    .where(and(eq(blockers.status, 'active'), or(inArray(blockers.requirementId, reqIds), inArray(blockers.workItemId, wiIds))))
    .orderBy(asc(blockers.createdAt), asc(blockers.id));
  for (const r of rows) {
    const id = (r.requirementId ?? r.workItemId)!;
    out.set(id, [...(out.get(id) ?? []), r.description]);
  }
  return out;
}

/** 类型、优先级、工作类型的取值：对象 id → 字段 key → 选项。 */
async function optionsTx(tx: Tx, ids: string[]): Promise<Map<string, Map<string, OptionRef>>> {
  const out = new Map<string, Map<string, OptionRef>>();
  if (ids.length === 0) return out;
  const rows = await tx
    .select({ entityId: fieldValues.entityId, fieldKey: fieldDefinitions.key, id: fieldOptions.id, key: fieldOptions.key, label: fieldOptions.label, color: fieldOptions.color })
    .from(fieldValues)
    .innerJoin(fieldDefinitions, eq(fieldDefinitions.id, fieldValues.fieldId))
    .innerJoin(fieldOptions, eq(fieldOptions.id, fieldValues.optionId))
    .where(and(inArray(fieldValues.entityId, ids), inArray(fieldDefinitions.key, ['type', 'priority', 'work_type'])));
  for (const r of rows) {
    const m = out.get(r.entityId) ?? new Map<string, OptionRef>();
    m.set(r.fieldKey, { id: r.id, key: r.key, label: r.label, color: r.color });
    out.set(r.entityId, m);
  }
  return out;
}

/** 已完成需求的上线时刻：最后一次从非完成类（或创建）进入完成类的流转。 */
async function completedAtTx(tx: Tx, rows: ReqRow[], meta: StateMeta): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  if (rows.length === 0) return out;
  const productOf = new Map(rows.map((r) => [r.id, r.productId]));
  const trans = await tx
    .select({ requirementId: stateTransitions.requirementId, fromState: stateTransitions.fromState, toState: stateTransitions.toState, at: stateTransitions.at })
    .from(stateTransitions)
    .where(inArray(stateTransitions.requirementId, rows.map((r) => r.id)))
    .orderBy(asc(stateTransitions.at), asc(stateTransitions.id));
  for (const tr of trans) {
    const states = meta.get(productOf.get(tr.requirementId)!);
    const category = (k: string | null) => (k ? states?.get(k)?.category : undefined) ?? 'backlog';
    if (category(tr.toState) === 'completed' && (tr.fromState === null || category(tr.fromState) !== 'completed')) out.set(tr.requirementId, tr.at);
  }
  return out;
}

/** 「类型」与「工作类型」的选项（组织级与可见产品的覆盖）：类型在前，各自按排序。 */
async function typeOptionsTx(tx: Tx, visible: string[]): Promise<OptionRef[]> {
  const defs = await tx
    .select({ id: fieldDefinitions.id, key: fieldDefinitions.key })
    .from(fieldDefinitions)
    .where(and(inArray(fieldDefinitions.key, ['type', 'work_type']), or(isNull(fieldDefinitions.productId), inArray(fieldDefinitions.productId, visible))));
  if (defs.length === 0) return [];
  const rank = new Map(defs.map((d) => [d.id, d.key === 'type' ? 0 : 1]));
  const rows = await tx.select().from(fieldOptions).where(inArray(fieldOptions.fieldId, defs.map((d) => d.id)));
  return rows
    .sort((a, b) => rank.get(a.fieldId)! - rank.get(b.fieldId)! || a.sort - b.sort)
    .map((o) => ({ id: o.id, key: o.key, label: o.label, color: o.color }));
}

export async function getTracking(db: Db, actor: Actor, filter: TrackingFilter = {}, opts: { now?: Date } = {}): Promise<TrackingList> {
  return withOrg(db, actor.orgId, async (tx) => {
    const timeZone = await orgTimeZone(tx, actor.orgId);
    const today = zonedDate(opts.now ?? new Date(), timeZone);
    const cutoff = addDays(today, -RECENT_DONE_DAYS);
    const [org] = await tx.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, actor.orgId));
    const settings = trackingSettingsOf(org?.settings ?? {});

    const visible = [...(await visibleProductIds(tx, actor))];
    const roles = new Map<string, ProductRole | null>();
    for (const id of visible) roles.set(id, await productRoleOf(tx, actor, id));
    const productRows = visible.length
      ? await tx.select({ id: products.id, key: products.key, name: products.name }).from(products).where(inArray(products.id, visible)).orderBy(asc(products.key))
      : [];
    // 没有指定流程的产品：状态列表为空，其需求按收集类别处理
    const workflowBodies = productRows.length
      ? await tx
          .select({ productId: products.id, body: workflowVersions.body })
          .from(products)
          .leftJoin(workflowVersions, eq(workflowVersions.id, products.workflowVersionId))
          .where(inArray(products.id, productRows.map((p) => p.id)))
      : [];
    const bodyOf = new Map(workflowBodies.map((r) => [r.productId, r.body as WorkflowBody | null]));
    const productList: TrackingProduct[] = [];
    const meta: StateMeta = new Map();
    for (const p of productRows) {
      const states = [...(bodyOf.get(p.id)?.states ?? [])]
        .sort((a, b) => a.order - b.order)
        .map((s) => ({ key: s.key, label: s.label, color: s.color, category: s.category, order: s.order }));
      productList.push({ ...p, states });
      meta.set(p.id, new Map(states.map((s) => [s.key, s])));
    }
    const productById = new Map(productRows.map((p) => [p.id, p]));
    // 合法但看不到或不存在的产品：范围为空，结果为空（不报错，也不暴露该产品是否存在）
    const scope = filter.productId ? visible.filter((id) => id === filter.productId) : visible;
    const unlinked = !filter.productId && canViewUnlinked(actor);
    const stageOf = (r: ReqRow): TrackingStage => meta.get(r.productId)?.get(r.stateKey) ?? { key: r.stateKey, label: r.stateKey, color: '#8a9199', category: 'backlog' };

    // 需求：已加入跟进；在手 = 当前状态不在已完成、已取消类别（退回收集也算）；「含最近完成」时加上最近 30 天上线的
    const reqRows = await tx
      .select()
      .from(requirements)
      .where(and(inArray(requirements.productId, scope), isNull(requirements.deletedAt), isNotNull(requirements.trackedSince)));
    const completedAt = await completedAtTx(tx, filter.includeDone ? reqRows.filter((r) => stageOf(r).category === 'completed') : [], meta);
    const doneAtOf = (r: ReqRow): Date => completedAt.get(r.id) ?? r.stateChangedAt;
    const reqs = reqRows.filter((r) => {
      const category = stageOf(r).category;
      if (!CLOSED_CATEGORIES.includes(category)) return true;
      return category === 'completed' && !!filter.includeDone && zonedDate(doneAtOf(r), timeZone) >= cutoff;
    });

    // 工作项：进行中；「含最近完成」时加上最近 30 天完成的
    const statuses: WorkItemStatus[] = filter.includeDone ? ['active', 'done'] : ['active'];
    const wiRows = (
      await tx
        .select()
        .from(workItems)
        .where(and(isNull(workItems.deletedAt), inArray(workItems.status, statuses), or(inArray(workItems.productId, scope), unlinked ? isNull(workItems.productId) : sql`false`)))
    ).filter((w) => w.status === 'active' || (w.doneAt !== null && zonedDate(w.doneAt, timeZone) >= cutoff));

    const reqIds = reqs.map((r) => r.id);
    const wiIds = wiRows.map((w) => w.id);
    const pauses = await pausesTx(tx, [...reqIds, ...wiIds]);
    const latest = await latestProgressTx(tx, reqIds, wiIds);
    const blockerMap = await activeBlockersTx(tx, reqIds, wiIds);
    const options = await optionsTx(tx, [...reqIds, ...wiIds]);
    const names = await memberNames(tx, [
      ...reqs.map((r) => r.ownerMemberId),
      ...wiRows.map((w) => w.ownerMemberId),
      ...[...latest.values()].map((p) => p.followerMemberId),
    ]);
    const ref = (id: string | null): MemberRef | null => (id ? { id, displayName: names.get(id) ?? '已删除的成员' } : null);
    const latestOf = (id: string): TrackingItem['latest'] => {
      const p = latest.get(id);
      return p ? { body: p.body, nextStep: p.nextStep, follower: ref(p.followerMemberId), createdAt: p.createdAt } : null;
    };
    const blockersOf = (id: string) => {
      const list = blockerMap.get(id) ?? [];
      return { count: list.length, first: list[0] ?? null };
    };
    const optionOf = (id: string, key: string): OptionRef | null => options.get(id)?.get(key) ?? null;

    const items: TrackingItem[] = [
      ...reqs.map((r): TrackingItem => {
        const stage = stageOf(r);
        const done = CLOSED_CATEGORIES.includes(stage.category);
        const until = done ? doneAtOf(r) : null;
        const intervals = pauseIntervals(pauses.get(r.id) ?? []);
        const stageDays = activeDays(r.stateChangedAt, until, today, intervals, timeZone);
        const paused = r.pausedAt !== null;
        const canWrite = atLeast(roles.get(r.productId) ?? null, 'editor');
        return {
          kind: 'requirement',
          id: r.id,
          displayKey: displayKey(productById.get(r.productId)!.key, r.number),
          title: r.title,
          product: productById.get(r.productId)!,
          owner: ref(r.ownerMemberId),
          type: optionOf(r.id, 'type'),
          priority: optionOf(r.id, 'priority'),
          stage,
          paused: r.pausedAt ? { at: r.pausedAt, reason: r.pauseReason ?? '' } : null,
          stageDays,
          wipDays: activeDays(r.trackedSince!, until, today, intervals, timeZone),
          aging: done ? 'normal' : agingLevel(stageDays, paused, settings),
          stale: !done && isStale(latest.get(r.id)?.createdAt ?? r.trackedSince!, paused, today, timeZone, settings),
          startedOn: zonedDate(r.trackedSince!, timeZone),
          stageEnteredOn: zonedDate(r.stateChangedAt, timeZone),
          blockers: blockersOf(r.id),
          latest: latestOf(r.id),
          expectedDate: r.expectedDate,
          doneOn: until ? zonedDate(until, timeZone) : null,
          done,
          canWrite,
          canEditDate: canWrite,
        };
      }),
      ...wiRows.map((w): TrackingItem => {
        const done = w.status === 'done';
        const start = w.startedOn ?? zonedDate(w.createdAt, timeZone);
        const until = done ? w.doneAt : null;
        const days = activeDays(start, until, today, pauseIntervals(pauses.get(w.id) ?? []), timeZone);
        const paused = w.pausedAt !== null;
        const canWrite = w.productId ? atLeast(roles.get(w.productId) ?? null, 'editor') : canWriteUnlinked(actor);
        return {
          kind: 'work_item',
          id: w.id,
          displayKey: workItemDisplayKey(w.number),
          title: w.title,
          product: w.productId ? productById.get(w.productId)! : null,
          owner: ref(w.ownerMemberId),
          type: optionOf(w.id, 'work_type'),
          priority: null,
          stage: { key: w.status, label: WORK_ITEM_STATUS_LABELS[w.status], color: WORK_ITEM_COLOR[w.status], category: WORK_ITEM_CATEGORY[w.status] },
          paused: w.pausedAt ? { at: w.pausedAt, reason: w.pauseReason ?? '' } : null,
          stageDays: days,
          wipDays: days,
          aging: done ? 'normal' : agingLevel(days, paused, settings),
          stale: !done && isStale(latest.get(w.id)?.createdAt ?? w.createdAt, paused, today, timeZone, settings),
          startedOn: start,
          stageEnteredOn: start,
          blockers: blockersOf(w.id),
          latest: latestOf(w.id),
          expectedDate: w.expectedDate,
          doneOn: until ? zonedDate(until, timeZone) : null,
          done,
          canWrite,
          canEditDate: w.productId ? canWrite : canEditUnlinked(actor, w),
        };
      }),
    ];

    const owners = [...new Map(items.flatMap((i) => (i.owner ? [[i.owner.id, i.owner] as const] : []))).values()].sort((a, b) =>
      a.displayName.localeCompare(b.displayName, 'zh-CN'),
    );
    const shown = items
      .filter(
        (i) =>
          (!filter.ownerId || i.owner?.id === filter.ownerId) &&
          (!filter.typeOptionId || i.type?.id === filter.typeOptionId) &&
          (!filter.paused || i.paused !== null) &&
          (!filter.blocked || i.blockers.count > 0),
      )
      .sort((a, b) => b.stageDays - a.stageDays || a.displayKey.localeCompare(b.displayKey, 'zh-CN', { numeric: true }));
    return { today, timeZone, settings, products: productList, owners, typeOptions: await typeOptionsTx(tx, visible), items: shown };
  });
}
