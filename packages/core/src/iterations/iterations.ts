import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { atLeast, isOrgAdmin, productRoleOf, requireOrgAdmin, requireProductRole, visibleProductIds } from '../access/permissions';
import { assertIsoDate } from '../dates';
import type { Db } from '../db/client';
import { blockers, type IterationMilestone, iterationScopeSnapshots, iterations, products, releases, requirements, tasks } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor, ProductRole } from '../domain-types';
import { AppError, pgErrorCode } from '../errors';
import { recordEvent } from '../events';
import { memberNames, productWorkflowBody } from '../requirements/context';
import { displayKey, type MemberRef } from '../requirements/requirements';

export type IterationStatus = 'planning' | 'active' | 'done' | 'canceled';
export const ITERATION_STATUS_LABELS: Record<IterationStatus, string> = { planning: '规划中', active: '进行中', done: '已完成', canceled: '已取消' };
const NEXT_STATUS: Record<IterationStatus, IterationStatus[]> = { planning: ['active', 'canceled'], active: ['done', 'canceled'], done: [], canceled: [] };

export type StateInfo = { label: string; color: string; category: string };
export type IterationView = {
  id: string;
  type: 'regular' | 'special';
  product: { id: string; key: string; name: string } | null;
  name: string;
  startDate: string;
  endDate: string;
  baselineEndDate: string | null;
  status: IterationStatus;
  milestones: IterationMilestone[];
  requirementCount: number;
  doneCount: number;
  canManage: boolean;
};
export type IterationRequirement = {
  id: string;
  productId: string;
  displayKey: string;
  title: string;
  stateKey: string;
  state: StateInfo;
  owner: MemberRef | null;
  activeBlockers: number;
  canEdit: boolean;
};
export type IterationDetail = IterationView & { requirements: IterationRequirement[] };
export type IterationScopeItem = { id: string; displayKey: string; title: string; state: StateInfo; currentIteration: { id: string; name: string } | null };
export type IterationScope = {
  hasSnapshot: boolean;
  snapshotAt: Date | null;
  committedDone: IterationScopeItem[];
  committedOpen: IterationScopeItem[];
  addedLater: IterationScopeItem[];
  removed: IterationScopeItem[];
};

type IterRow = typeof iterations.$inferSelect;
type ReqRow = typeof requirements.$inferSelect;
type Change = { field: string; old: unknown; new: unknown };

function assertName(name: string): string {
  const n = name.trim();
  if (!n || n.length > 50) throw new AppError('invalid', '迭代名称不能为空，且不超过 50 个字符');
  return n;
}

function assertMilestones(list: IterationMilestone[]): IterationMilestone[] {
  if (list.length > 20) throw new AppError('invalid', '里程碑不超过 20 个');
  return list
    .map((m) => {
      const label = m.label.trim();
      if (!label || label.length > 20) throw new AppError('invalid', '里程碑名称不能为空，且不超过 20 个字符');
      return { label, date: assertIsoDate(m.date, '里程碑日期') };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

function overlapToConflict(e: unknown): never {
  if (pgErrorCode(e) === '23P01') throw new AppError('conflict', '与已有迭代时间重叠');
  throw e;
}

export async function stateInfoByProduct(tx: Tx, productIds: Iterable<string>): Promise<Map<string, Map<string, StateInfo>>> {
  const out = new Map<string, Map<string, StateInfo>>();
  for (const pid of new Set(productIds)) {
    const body = await productWorkflowBody(tx, pid);
    out.set(pid, new Map(body.states.map((s) => [s.key, { label: s.label, color: s.color, category: s.category }])));
  }
  return out;
}

export function stateOf(info: Map<string, Map<string, StateInfo>>, productId: string, key: string): StateInfo {
  return info.get(productId)?.get(key) ?? { label: key, color: '#8a9199', category: 'backlog' };
}

function isVisible(row: IterRow, visible: Set<string>): boolean {
  return row.type === 'special' ? visible.size > 0 : visible.has(row.productId!);
}

/** 读取迭代；`lock` 为 'share' 或 'update' 时对该行加对应的行锁。任务写操作（tasks.ts）复用本函数，不另建加锁函数。 */
export async function loadIteration(tx: Tx, id: string, lock?: 'share' | 'update'): Promise<IterRow> {
  const where = and(eq(iterations.id, id), isNull(iterations.deletedAt));
  const [row] = lock ? await tx.select().from(iterations).where(where).for(lock) : await tx.select().from(iterations).where(where);
  if (!row) throw new AppError('not_found', '迭代不存在');
  return row;
}

/** 读取并确认操作者能看到该迭代；看不到时与不存在一样返回 404。 */
export async function loadVisibleIteration(tx: Tx, id: string, visible: Set<string>, lock?: 'share' | 'update'): Promise<IterRow> {
  const row = await loadIteration(tx, id, lock);
  if (!isVisible(row, visible)) throw new AppError('not_found', '迭代不存在');
  return row;
}

/** 常规迭代的新建、修改、状态流转与删除需要产品编辑者及以上；专项仍要求组织管理员。 */
async function requireManage(tx: Tx, actor: Actor, row: IterRow): Promise<void> {
  if (row.type === 'special') requireOrgAdmin(actor);
  else await requireProductRole(tx, actor, row.productId!, 'editor');
}

async function buildViews(tx: Tx, actor: Actor, rows: IterRow[], visible: Set<string>): Promise<IterationView[]> {
  if (rows.length === 0) return [];
  const reqs =
    visible.size > 0
      ? await tx
          .select({ iterationId: requirements.iterationId, productId: requirements.productId, stateKey: requirements.stateKey })
          .from(requirements)
          .where(and(inArray(requirements.iterationId, rows.map((r) => r.id)), isNull(requirements.deletedAt), inArray(requirements.productId, [...visible])))
      : [];
  const info = await stateInfoByProduct(tx, reqs.map((r) => r.productId));
  const productIds = [...new Set(rows.map((r) => r.productId).filter((x): x is string => !!x))];
  const prods = productIds.length
    ? await tx.select({ id: products.id, key: products.key, name: products.name }).from(products).where(inArray(products.id, productIds))
    : [];
  const manage = new Map<string, boolean>();
  const canManage = async (r: IterRow): Promise<boolean> => {
    if (r.type === 'special') return isOrgAdmin(actor);
    if (!manage.has(r.productId!)) manage.set(r.productId!, atLeast(await productRoleOf(tx, actor, r.productId!), 'editor'));
    return manage.get(r.productId!)!;
  };
  const out: IterationView[] = [];
  for (const r of rows) {
    const mine = reqs.filter((x) => x.iterationId === r.id);
    out.push({
      id: r.id,
      type: r.type,
      product: r.productId ? (prods.find((p) => p.id === r.productId) ?? null) : null,
      name: r.name,
      startDate: r.startDate,
      endDate: r.endDate,
      baselineEndDate: r.baselineEndDate,
      status: r.status,
      milestones: r.milestones,
      requirementCount: mine.length,
      doneCount: mine.filter((x) => stateOf(info, x.productId, x.stateKey).category === 'completed').length,
      canManage: await canManage(r),
    });
  }
  return out;
}

async function productKeys(tx: Tx, productIds: string[]): Promise<Map<string, string>> {
  if (productIds.length === 0) return new Map();
  const rows = await tx.select({ id: products.id, key: products.key }).from(products).where(inArray(products.id, productIds));
  return new Map(rows.map((p) => [p.id, p.key]));
}

async function iterationRequirements(tx: Tx, actor: Actor, rows: ReqRow[]): Promise<IterationRequirement[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const productIds = [...new Set(rows.map((r) => r.productId))];
  const keys = await productKeys(tx, productIds);
  const info = await stateInfoByProduct(tx, productIds);
  const names = await memberNames(tx, rows.map((r) => r.ownerMemberId));
  const counts = await tx
    .select({ requirementId: blockers.requirementId, n: sql<number>`count(*)::int` })
    .from(blockers)
    .where(and(inArray(blockers.requirementId, ids), eq(blockers.status, 'active')))
    .groupBy(blockers.requirementId);
  const roles = new Map<string, ProductRole | null>();
  for (const pid of productIds) roles.set(pid, await productRoleOf(tx, actor, pid));
  return rows.map((r) => ({
    id: r.id,
    productId: r.productId,
    displayKey: displayKey(keys.get(r.productId)!, r.number),
    title: r.title,
    stateKey: r.stateKey,
    state: stateOf(info, r.productId, r.stateKey),
    owner: r.ownerMemberId ? { id: r.ownerMemberId, displayName: names.get(r.ownerMemberId) ?? '已删除的成员' } : null,
    activeBlockers: counts.find((c) => c.requirementId === r.id)?.n ?? 0,
    canEdit: atLeast(roles.get(r.productId) ?? null, 'editor'),
  }));
}

export async function listIterations(db: Db, actor: Actor, input: { productId?: string } = {}): Promise<IterationView[]> {
  return withOrg(db, actor.orgId, async (tx) => {
    const visible = await visibleProductIds(tx, actor);
    if (input.productId && !visible.has(input.productId)) throw new AppError('not_found', '产品不存在');
    if (visible.size === 0) return [];
    const scope = input.productId
      ? or(eq(iterations.productId, input.productId), eq(iterations.type, 'special'))
      : or(inArray(iterations.productId, [...visible]), eq(iterations.type, 'special'));
    const rows = await tx
      .select()
      .from(iterations)
      .where(and(isNull(iterations.deletedAt), scope))
      .orderBy(desc(iterations.startDate), asc(iterations.name));
    return buildViews(tx, actor, rows, visible);
  });
}

export async function getIteration(db: Db, actor: Actor, id: string): Promise<IterationDetail> {
  return withOrg(db, actor.orgId, async (tx) => {
    const visible = await visibleProductIds(tx, actor);
    const row = await loadVisibleIteration(tx, id, visible);
    const [view] = await buildViews(tx, actor, [row], visible);
    const reqRows = await tx
      .select()
      .from(requirements)
      .where(and(eq(requirements.iterationId, id), isNull(requirements.deletedAt), inArray(requirements.productId, [...visible])))
      .orderBy(asc(requirements.productId), asc(requirements.number));
    return { ...view!, requirements: await iterationRequirements(tx, actor, reqRows) };
  });
}

export async function createIteration(
  db: Db,
  actor: Actor,
  input: { type: 'regular' | 'special'; productId?: string | null; name: string; startDate: string; endDate: string; milestones?: IterationMilestone[] },
): Promise<IterationView> {
  const name = assertName(input.name);
  const startDate = assertIsoDate(input.startDate, '开始日期');
  const endDate = assertIsoDate(input.endDate, '结束日期');
  if (startDate > endDate) throw new AppError('invalid', '结束日期不能早于开始日期');
  const milestones = assertMilestones(input.milestones ?? []);
  if (input.type === 'regular' && !input.productId) throw new AppError('invalid', '常规迭代必须属于一个产品');
  if (input.type === 'special' && input.productId) throw new AppError('invalid', '专项属于组织，不能指定产品');
  return withOrg(db, actor.orgId, async (tx) => {
    if (input.type === 'special') requireOrgAdmin(actor);
    else await requireProductRole(tx, actor, input.productId!, 'editor');
    let row: IterRow;
    try {
      [row] = (await tx
        .insert(iterations)
        .values({ orgId: actor.orgId, productId: input.type === 'regular' ? input.productId! : null, type: input.type, name, startDate, endDate, milestones })
        .returning()) as [IterRow];
    } catch (e) {
      overlapToConflict(e);
    }
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: row.productId,
      type: 'iteration.created',
      subjectType: 'iteration',
      subjectId: row.id,
      actor,
      payload: { name, type: row.type, startDate, endDate },
    });
    const [view] = await buildViews(tx, actor, [row], await visibleProductIds(tx, actor));
    return view!;
  });
}

export async function updateIteration(
  db: Db,
  actor: Actor,
  id: string,
  input: { name?: string; startDate?: string; endDate?: string; milestones?: IterationMilestone[] },
): Promise<IterationView> {
  return withOrg(db, actor.orgId, async (tx) => {
    const visible = await visibleProductIds(tx, actor);
    const cur = await loadVisibleIteration(tx, id, visible, 'update');
    await requireManage(tx, actor, cur);
    if (cur.status === 'done' || cur.status === 'canceled') throw new AppError('invalid', '已完成或已取消的迭代不能修改');
    const next = {
      name: input.name === undefined ? cur.name : assertName(input.name),
      startDate: input.startDate === undefined ? cur.startDate : assertIsoDate(input.startDate, '开始日期'),
      endDate: input.endDate === undefined ? cur.endDate : assertIsoDate(input.endDate, '结束日期'),
      milestones: input.milestones === undefined ? cur.milestones : assertMilestones(input.milestones),
    };
    if (next.startDate > next.endDate) throw new AppError('invalid', '结束日期不能早于开始日期');
    const changes: Change[] = (['name', 'startDate', 'endDate'] as const)
      .map((field) => ({ field, old: cur[field], new: next[field] }))
      .filter((c) => c.old !== c.new);
    if (JSON.stringify(cur.milestones) !== JSON.stringify(next.milestones)) changes.push({ field: 'milestones', old: cur.milestones, new: next.milestones });
    let row: IterRow;
    try {
      [row] = (await tx.update(iterations).set(next).where(eq(iterations.id, id)).returning()) as [IterRow];
    } catch (e) {
      overlapToConflict(e);
    }
    if (changes.length > 0) {
      await recordEvent(tx, { orgId: actor.orgId, productId: cur.productId, type: 'iteration.updated', subjectType: 'iteration', subjectId: id, actor, payload: { changes } });
    }
    const [view] = await buildViews(tx, actor, [row], visible);
    return view!;
  });
}

export async function setIterationStatus(db: Db, actor: Actor, id: string, to: IterationStatus): Promise<IterationView> {
  return withOrg(db, actor.orgId, async (tx) => {
    const visible = await visibleProductIds(tx, actor);
    const cur = await loadVisibleIteration(tx, id, visible, 'update');
    await requireManage(tx, actor, cur);
    if (!NEXT_STATUS[cur.status].includes(to)) {
      throw new AppError('invalid', `不能从「${ITERATION_STATUS_LABELS[cur.status]}」变为「${ITERATION_STATUS_LABELS[to] ?? to}」`);
    }
    const now = new Date();
    let snapshotCount = 0;
    const set: Partial<typeof iterations.$inferInsert> = { status: to };
    if (to === 'active') {
      set.baselineEndDate = cur.endDate;
      const [existing] = await tx
        .select({ id: iterationScopeSnapshots.id })
        .from(iterationScopeSnapshots)
        .where(and(eq(iterationScopeSnapshots.iterationId, id), eq(iterationScopeSnapshots.snapshotKind, 'committed')))
        .limit(1);
      if (!existing) {
        const inScope = await tx.select({ id: requirements.id }).from(requirements).where(and(eq(requirements.iterationId, id), isNull(requirements.deletedAt)));
        if (inScope.length > 0) {
          await tx
            .insert(iterationScopeSnapshots)
            .values(inScope.map((r) => ({ orgId: actor.orgId, iterationId: id, requirementId: r.id, snapshotKind: 'committed' as const, at: now })));
        }
        snapshotCount = inScope.length;
      }
    }
    const [row] = await tx.update(iterations).set(set).where(eq(iterations.id, id)).returning();
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: cur.productId,
      type: 'iteration.status_changed',
      subjectType: 'iteration',
      subjectId: id,
      actor,
      payload: { changes: [{ field: 'status', old: cur.status, new: to }], snapshotCount },
    });
    const [view] = await buildViews(tx, actor, [row!], visible);
    return view!;
  });
}

export async function deleteIteration(db: Db, actor: Actor, id: string): Promise<void> {
  return withOrg(db, actor.orgId, async (tx) => {
    const visible = await visibleProductIds(tx, actor);
    const cur = await loadVisibleIteration(tx, id, visible, 'update');
    await requireManage(tx, actor, cur);
    if (cur.status !== 'planning') throw new AppError('invalid', '只能删除规划中的迭代');
    const [reqCount] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(requirements)
      .where(and(eq(requirements.iterationId, id), isNull(requirements.deletedAt)));
    if (reqCount!.n > 0) throw new AppError('invalid', '迭代中还有需求，请先移出');
    const [taskCount] = await tx.select({ n: sql<number>`count(*)::int` }).from(tasks).where(eq(tasks.iterationId, id));
    if (taskCount!.n > 0) throw new AppError('invalid', '迭代中还有任务，请先删除');
    const [relCount] = await tx.select({ n: sql<number>`count(*)::int` }).from(releases).where(eq(releases.iterationId, id));
    if (relCount!.n > 0) throw new AppError('invalid', '迭代下还有发布版本，请先改到其他迭代');
    await tx.update(iterations).set({ deletedAt: new Date() }).where(eq(iterations.id, id));
    await recordEvent(tx, { orgId: actor.orgId, productId: cur.productId, type: 'iteration.deleted', subjectType: 'iteration', subjectId: id, actor, payload: { name: cur.name } });
  });
}

export async function getIterationScope(db: Db, actor: Actor, id: string): Promise<IterationScope> {
  return withOrg(db, actor.orgId, async (tx) => {
    const visible = await visibleProductIds(tx, actor);
    const row = await loadVisibleIteration(tx, id, visible);
    if (row.status === 'planning') throw new AppError('invalid', '迭代开始后才有范围对比');
    const snaps = await tx
      .select({ requirementId: iterationScopeSnapshots.requirementId, at: iterationScopeSnapshots.at })
      .from(iterationScopeSnapshots)
      .where(and(eq(iterationScopeSnapshots.iterationId, id), eq(iterationScopeSnapshots.snapshotKind, 'committed')));
    const committed = new Set(snaps.map((s) => s.requirementId));
    const current = await tx.select().from(requirements).where(and(eq(requirements.iterationId, id), isNull(requirements.deletedAt)));
    const currentIds = new Set(current.map((r) => r.id));
    const removedIds = [...committed].filter((x) => !currentIds.has(x));
    const removedRows = removedIds.length
      ? await tx.select().from(requirements).where(and(inArray(requirements.id, removedIds), isNull(requirements.deletedAt)))
      : [];
    const shownCurrent = current.filter((r) => visible.has(r.productId));
    const shownRemoved = removedRows.filter((r) => visible.has(r.productId));
    const productIds = [...new Set([...shownCurrent, ...shownRemoved].map((r) => r.productId))];
    const keys = await productKeys(tx, productIds);
    const info = await stateInfoByProduct(tx, productIds);
    const otherIds = [...new Set(shownRemoved.map((r) => r.iterationId).filter((x): x is string => !!x))];
    const others = otherIds.length ? await tx.select({ id: iterations.id, name: iterations.name }).from(iterations).where(inArray(iterations.id, otherIds)) : [];
    const item = (r: ReqRow): IterationScopeItem => ({
      id: r.id,
      displayKey: displayKey(keys.get(r.productId)!, r.number),
      title: r.title,
      state: stateOf(info, r.productId, r.stateKey),
      currentIteration: r.iterationId === null ? null : r.iterationId === id ? { id, name: row.name } : (others.find((o) => o.id === r.iterationId) ?? null),
    });
    const byKey = (a: IterationScopeItem, b: IterationScopeItem) => a.displayKey.localeCompare(b.displayKey, 'zh-CN', { numeric: true });
    const inCommitment = shownCurrent.filter((r) => committed.has(r.id));
    const isDone = (r: ReqRow) => stateOf(info, r.productId, r.stateKey).category === 'completed';
    return {
      hasSnapshot: snaps.length > 0,
      snapshotAt: snaps.length > 0 ? snaps.reduce((min, s) => (s.at < min ? s.at : min), snaps[0]!.at) : null,
      committedDone: inCommitment.filter(isDone).map(item).sort(byKey),
      committedOpen: inCommitment.filter((r) => !isDone(r)).map(item).sort(byKey),
      addedLater: shownCurrent.filter((r) => !committed.has(r.id)).map(item).sort(byKey),
      removed: shownRemoved.map(item).sort(byKey),
    };
  });
}
