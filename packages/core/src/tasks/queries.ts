import { and, asc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { atLeast, productRoleOf, visibleProductIds } from '../access/permissions';
import type { Db } from '../db/client';
import { iterations, members, products, tasks } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError } from '../errors';
import { type IterationStatus, loadVisibleIteration } from '../iterations/iterations';
import { parseTaskKey } from '../links/syntax';
import { loadRequirement } from '../requirements/context';
import type { MemberRef } from '../requirements/requirements';
import { type IterationOverview, iterationOverview, workdaysBetween } from './schedule';
import { hydrateTasks, orgToday, type TaskView } from './tasks';

export type IterationGantt = {
  iteration: {
    id: string;
    name: string;
    type: 'regular' | 'special';
    product: { id: string; key: string; name: string } | null;
    startDate: string;
    endDate: string;
    status: IterationStatus;
  };
  today: string;
  workdays: string[];
  tasks: TaskView[];
  overview: IterationOverview;
  starredCount: number;
  canAddTask: boolean;
  /** 操作者可以在本迭代里新建任务的产品（专项有多个时由界面选择）。 */
  editableProductIds: string[];
};
export type MemberTask = TaskView & { iteration: { id: string; name: string; startDate: string; endDate: string; status: IterationStatus } | null };
export type MemberTasks = { member: MemberRef; today: string; tasks: MemberTask[] };

export type TaskDetail = TaskView & {
  productKey: string;
  iteration: { id: string; name: string; status: IterationStatus } | null;
  createdAt: Date;
};

const TASK_NOT_FOUND = '任务不存在';

/** 任务详情：编号形如 PAN-T-12（大小写不敏感）。看不到所属产品时与不存在一样。 */
export async function getTaskByKey(db: Db, actor: Actor, key: string, opts: { today?: string } = {}): Promise<TaskDetail> {
  const parsed = parseTaskKey(key);
  if (!parsed) throw new AppError('not_found', TASK_NOT_FOUND);
  return withOrg(db, actor.orgId, async (tx) => {
    const [row] = await tx
      .select({ t: tasks })
      .from(tasks)
      .innerJoin(products, eq(products.id, tasks.productId))
      .where(and(eq(products.key, parsed.productKey), eq(tasks.number, parsed.number), isNull(products.deletedAt)));
    if (!row || !(await productRoleOf(tx, actor, row.t.productId))) throw new AppError('not_found', TASK_NOT_FOUND);
    const [view] = await hydrateTasks(tx, actor, [row.t], opts.today ?? (await orgToday(tx, actor.orgId)));
    const [it] = row.t.iterationId
      ? await tx
          .select({ id: iterations.id, name: iterations.name, status: iterations.status })
          .from(iterations)
          .where(and(eq(iterations.id, row.t.iterationId), isNull(iterations.deletedAt)))
      : [];
    return { ...view!, productKey: parsed.productKey, iteration: it ?? null, createdAt: row.t.createdAt };
  });
}

const byPlanStart = [sql`${tasks.planStart} asc nulls last`, asc(tasks.createdAt)] as const;

/**
 * 迭代里指定产品的任务（重点在前、其余按开始日期）与迭代概览。甘特页与推送的概览卡片共用，
 * 保证两处的整体进度同一口径。actor 为空（后台推送）时任务的 canEdit 为 false。
 */
export async function iterationTasksOverviewTx(
  tx: Tx,
  actor: Actor | null,
  it: { id: string; startDate: string; endDate: string },
  productIds: string[],
  today: string,
): Promise<{ tasks: TaskView[]; overview: IterationOverview }> {
  const rows =
    productIds.length > 0
      ? await tx
          .select()
          .from(tasks)
          .where(and(eq(tasks.iterationId, it.id), inArray(tasks.productId, productIds)))
          .orderBy(...byPlanStart)
      : [];
  // 重点任务排在前面；sort 是稳定排序，其余保持开始日期顺序
  const views = (await hydrateTasks(tx, actor, rows, today)).sort((a, b) => Number(b.starred) - Number(a.starred));
  const overview = iterationOverview(
    views.map((v) => ({
      status: v.status,
      planStart: v.planStart,
      planDays: v.planDays,
      delayDays: v.delayDays,
      progressOverride: v.progressOverride,
      requirementId: v.requirement?.id ?? null,
      title: v.requirement ? `${v.requirement.displayKey} ${v.requirement.title}` : v.title,
      flag: v.flag,
      note: v.note,
      assigneeName: v.assignee?.displayName ?? null,
    })),
    it,
    today,
  );
  return { tasks: views, overview };
}

export async function getIterationGantt(db: Db, actor: Actor, iterationId: string, opts: { today?: string } = {}): Promise<IterationGantt> {
  return withOrg(db, actor.orgId, async (tx) => {
    const visible = await visibleProductIds(tx, actor);
    const it = await loadVisibleIteration(tx, iterationId, visible);
    const today = opts.today ?? (await orgToday(tx, actor.orgId));
    const { tasks: views, overview } = await iterationTasksOverviewTx(tx, actor, it, [...visible], today);
    const [product] = it.productId
      ? await tx.select({ id: products.id, key: products.key, name: products.name }).from(products).where(eq(products.id, it.productId))
      : [];
    const open = it.status === 'planning' || it.status === 'active';
    const editableProductIds: string[] = [];
    if (open) {
      for (const pid of it.type === 'regular' ? [it.productId!] : [...visible]) {
        if (atLeast(await productRoleOf(tx, actor, pid), 'editor')) editableProductIds.push(pid);
      }
    }
    return {
      iteration: { id: it.id, name: it.name, type: it.type, product: product ?? null, startDate: it.startDate, endDate: it.endDate, status: it.status },
      today,
      workdays: workdaysBetween(it.startDate, it.endDate),
      tasks: views,
      overview,
      starredCount: views.filter((v) => v.starred).length,
      canAddTask: editableProductIds.length > 0,
      editableProductIds,
    };
  });
}

export async function listRequirementTasks(db: Db, actor: Actor, requirementId: string, opts: { today?: string } = {}): Promise<TaskView[]> {
  return withOrg(db, actor.orgId, async (tx) => {
    const req = await loadRequirement(tx, requirementId);
    if (!(await productRoleOf(tx, actor, req.productId))) throw new AppError('not_found', '需求不存在');
    const rows = await tx.select().from(tasks).where(eq(tasks.requirementId, requirementId)).orderBy(...byPlanStart);
    return hydrateTasks(tx, actor, rows, opts.today ?? (await orgToday(tx, actor.orgId)));
  });
}

export async function listMemberTasks(
  db: Db,
  actor: Actor,
  memberId: string,
  opts: { today?: string; includeFinished?: boolean } = {},
): Promise<MemberTasks> {
  // 访客只能查询自己的任务：listMembers 对访客本就拒绝，这里不能借着按人查询任务把其他成员的姓名和任务泄露出去。
  if (actor.orgRole === 'guest' && memberId !== actor.memberId) throw new AppError('forbidden', '访客只能查看自己的任务');
  return withOrg(db, actor.orgId, async (tx) => {
    const [member] = await tx.select({ id: members.id, displayName: members.displayName }).from(members).where(eq(members.id, memberId));
    if (!member) throw new AppError('not_found', '成员不存在');
    const today = opts.today ?? (await orgToday(tx, actor.orgId));
    const visible = [...(await visibleProductIds(tx, actor))];
    if (visible.length === 0) return { member, today, tasks: [] };
    const scope = opts.includeFinished
      ? or(isNull(tasks.iterationId), isNull(iterations.deletedAt))
      : or(
          and(isNull(tasks.iterationId), ne(tasks.status, 'done')),
          and(isNull(iterations.deletedAt), inArray(iterations.status, ['planning', 'active'])),
        );
    const rows = await tx
      .select({
        t: tasks,
        it: { id: iterations.id, name: iterations.name, startDate: iterations.startDate, endDate: iterations.endDate, status: iterations.status },
      })
      .from(tasks)
      .leftJoin(iterations, eq(iterations.id, tasks.iterationId))
      .where(and(eq(tasks.assigneeMemberId, memberId), inArray(tasks.productId, visible), scope))
      .orderBy(...byPlanStart)
      .limit(500);
    const views = await hydrateTasks(tx, actor, rows.map((r) => r.t), today);
    return { member, today, tasks: views.map((v, i) => ({ ...v, iteration: rows[i]!.it })) };
  });
}
