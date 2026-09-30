import { and, eq, inArray, sql } from 'drizzle-orm';
import { atLeast, productRoleOf } from '../access/permissions';
import { assertIsoDate } from '../dates';
import type { Db } from '../db/client';
import { organizations, products, requirements, tasks } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor, ProductRole } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import { loadIteration } from '../iterations/iterations';
import { assertMemberInOrg, loadRequirement, memberNames } from '../requirements/context';
import { displayKey, type MemberRef } from '../requirements/requirements';
import { displayProgress, STARRED_LIMIT, TASK_FLAGS, type TaskFlag, todayInZone } from './schedule';

export const TASK_STATUSES = ['todo', 'doing', 'done'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
/** 组织没有设置时区时使用的默认值，与组织信息页的默认选项一致。 */
export const DEFAULT_TIMEZONE = 'Asia/Shanghai';
/** 任务不存在或操作者看不到所属产品时统一使用的文案，新建、修改、删除三个路径一致。 */
const TASK_NOT_FOUND = '任务不存在';

export type TaskView = {
  id: string;
  productId: string;
  iterationId: string | null;
  requirement: { id: string; displayKey: string; title: string } | null;
  title: string;
  alias: string | null;
  assignee: MemberRef | null;
  status: TaskStatus;
  planStart: string | null;
  planDays: number | null;
  delayDays: number | null;
  phase: string | null;
  flag: TaskFlag | null;
  starred: boolean;
  note: string | null;
  progressOverride: number | null;
  progress: number;
  canEdit: boolean;
  updatedAt: Date;
};

export type TaskPatch = {
  title?: string;
  alias?: string | null;
  assigneeMemberId?: string | null;
  status?: TaskStatus;
  planStart?: string | null;
  planDays?: number | null;
  delayDays?: number | null;
  phase?: string | null;
  flag?: TaskFlag | null;
  starred?: boolean;
  note?: string | null;
  progress?: number | null;
};
export type TaskCreateInput = TaskPatch & { title: string; iterationId?: string | null; requirementId?: string | null; productId?: string | null };

type TaskRow = typeof tasks.$inferSelect;
type Columns = Partial<
  Pick<typeof tasks.$inferInsert, 'title' | 'alias' | 'assigneeMemberId' | 'status' | 'planStart' | 'planDays' | 'delayDays' | 'phase' | 'flag' | 'starred'>
>;
/** 存在 tasks.meta 里的字段：说明与手动进度。 */
type MetaPatch = { note?: string | null; progress?: number | null };
type Change = { field: string; old: unknown; new: unknown };

function optionalText(value: string | null, max: number, message: string): string | null {
  const s = value?.trim() ?? '';
  if (s.length > max) throw new AppError('invalid', message);
  return s || null;
}

function halfDays(value: number | null, min: number, message: string): number | null {
  if (value === null) return null;
  if (!Number.isFinite(value) || value < min || value > 365 || !Number.isInteger(value * 2)) throw new AppError('invalid', message);
  return value;
}

function normalize(input: TaskPatch): { columns: Columns; meta: MetaPatch } {
  const columns: Columns = {};
  const meta: MetaPatch = {};
  if (input.title !== undefined) {
    const title = input.title.trim();
    if (!title || title.length > 200) throw new AppError('invalid', '任务名称不能为空，且不超过 200 个字符');
    columns.title = title;
  }
  if (input.alias !== undefined) columns.alias = optionalText(input.alias, 50, '别名不超过 50 个字符');
  if (input.assigneeMemberId !== undefined) columns.assigneeMemberId = input.assigneeMemberId;
  if (input.status !== undefined) {
    if (!(TASK_STATUSES as readonly string[]).includes(input.status)) throw new AppError('invalid', '任务状态无效');
    columns.status = input.status;
  }
  if (input.planStart !== undefined) columns.planStart = input.planStart === null ? null : assertIsoDate(input.planStart, '开始日期');
  if (input.planDays !== undefined) columns.planDays = halfDays(input.planDays, 0.5, '工期以半天为单位，范围 0.5–365 天');
  if (input.delayDays !== undefined) columns.delayDays = halfDays(input.delayDays, 0, '延期以半天为单位，范围 0–365 天');
  if (input.phase !== undefined) columns.phase = optionalText(input.phase, 20, '阶段不超过 20 个字符');
  if (input.flag !== undefined) {
    if (input.flag !== null && !(TASK_FLAGS as readonly string[]).includes(input.flag)) throw new AppError('invalid', '标记无效');
    columns.flag = input.flag;
  }
  if (input.starred !== undefined) columns.starred = input.starred;
  if (input.note !== undefined) meta.note = optionalText(input.note, 200, '说明不超过 200 个字符');
  if (input.progress !== undefined) {
    if (input.progress !== null && (!Number.isInteger(input.progress) || input.progress < 0 || input.progress > 100)) {
      throw new AppError('invalid', '进度应为 0–100 的整数');
    }
    meta.progress = input.progress;
  }
  return { columns, meta };
}

/** 组织时区的当天日期；时区值无效（如已损坏的设置）时退回默认时区，不让任务读写因此报错。 */
export async function orgToday(tx: Tx, orgId: string): Promise<string> {
  const [org] = await tx.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, orgId));
  const timeZone = org?.settings.timezone ?? DEFAULT_TIMEZONE;
  try {
    return todayInZone(timeZone);
  } catch {
    return todayInZone(DEFAULT_TIMEZONE);
  }
}

async function assertStarredRoom(tx: Tx, iterationId: string): Promise<void> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(tasks)
    .where(and(eq(tasks.iterationId, iterationId), eq(tasks.starred, true)));
  if (row!.n >= STARRED_LIMIT) throw new AppError('conflict', `每个迭代最多 ${STARRED_LIMIT} 个重点任务`);
}

/** 任务写操作的权限：看不到产品（或产品不存在）时与任务不存在一样返回 404；只读成员与只读 Token 返回 403。 */
async function requireTaskWrite(tx: Tx, actor: Actor, productId: string): Promise<void> {
  const role = await productRoleOf(tx, actor, productId);
  if (!role) throw new AppError('not_found', TASK_NOT_FOUND);
  if (!atLeast(role, 'editor')) throw new AppError('forbidden', '权限不足');
}

export async function hydrateTasks(tx: Tx, actor: Actor, rows: TaskRow[], today: string): Promise<TaskView[]> {
  if (rows.length === 0) return [];
  const reqIds = [...new Set(rows.map((r) => r.requirementId).filter((x): x is string => !!x))];
  const reqs = reqIds.length
    ? await tx
        .select({ id: requirements.id, number: requirements.number, title: requirements.title, key: products.key })
        .from(requirements)
        .innerJoin(products, eq(products.id, requirements.productId))
        .where(inArray(requirements.id, reqIds))
    : [];
  const names = await memberNames(tx, rows.map((r) => r.assigneeMemberId));
  const roles = new Map<string, ProductRole | null>();
  for (const pid of new Set(rows.map((r) => r.productId))) roles.set(pid, await productRoleOf(tx, actor, pid));
  return rows.map((r) => {
    const req = reqs.find((x) => x.id === r.requirementId);
    const progressOverride = typeof r.meta.progress === 'number' ? r.meta.progress : null;
    return {
      id: r.id,
      productId: r.productId,
      iterationId: r.iterationId,
      requirement: req ? { id: req.id, displayKey: displayKey(req.key, req.number), title: req.title } : null,
      title: r.title,
      alias: r.alias || null,
      assignee: r.assigneeMemberId ? { id: r.assigneeMemberId, displayName: names.get(r.assigneeMemberId) ?? '已删除的成员' } : null,
      status: r.status,
      planStart: r.planStart,
      planDays: r.planDays,
      delayDays: r.delayDays,
      phase: r.phase,
      flag: r.flag === 'attention' ? 'attention' : null,
      starred: r.starred ?? false,
      note: typeof r.meta.note === 'string' && r.meta.note ? r.meta.note : null,
      progressOverride,
      progress: displayProgress({ status: r.status, planStart: r.planStart, planDays: r.planDays, delayDays: r.delayDays, progressOverride }, today),
      canEdit: atLeast(roles.get(r.productId) ?? null, 'editor'),
      updatedAt: r.updatedAt,
    };
  });
}

export async function createTask(db: Db, actor: Actor, input: TaskCreateInput, opts: { today?: string } = {}): Promise<TaskView> {
  const { columns, meta } = normalize(input);
  if (!input.iterationId && !input.requirementId) throw new AppError('invalid', '任务需要属于一个迭代或一条需求');
  return withOrg(db, actor.orgId, async (tx) => {
    // 先不加锁读一次迭代，只为算出所属产品；权限检查通过后再加锁重读，保证锁顺序为「先迭代」且不早于权限校验。
    const peekIteration = input.iterationId ? await loadIteration(tx, input.iterationId) : null;
    const req = input.requirementId ? await loadRequirement(tx, input.requirementId) : null;
    const productId = req?.productId ?? (peekIteration?.type === 'regular' ? peekIteration.productId : input.productId) ?? null;
    if (!productId) throw new AppError('invalid', '专项里的任务需要指定所属产品');
    await requireTaskWrite(tx, actor, productId);
    const it = peekIteration ? await loadIteration(tx, peekIteration.id, columns.starred ? 'update' : 'share') : null;
    if (it) {
      if (it.type === 'regular' && it.productId !== productId) throw new AppError('invalid', '不能把任务放进其他产品的迭代');
      if (it.status !== 'planning' && it.status !== 'active') throw new AppError('invalid', '只能在规划中或进行中的迭代里新建任务');
    }
    if (columns.assigneeMemberId) await assertMemberInOrg(tx, columns.assigneeMemberId);
    if (columns.starred) {
      if (!it) throw new AppError('invalid', '只有迭代里的任务可以标为重点');
      await assertStarredRoom(tx, it.id);
    }
    const metaValue = Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== null));
    const [row] = await tx
      .insert(tasks)
      .values({ orgId: actor.orgId, productId, requirementId: req?.id ?? null, iterationId: it?.id ?? null, ...columns, title: columns.title!, meta: metaValue })
      .returning();
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId,
      type: 'task.created',
      subjectType: 'task',
      subjectId: row!.id,
      actor,
      payload: { title: row!.title, requirementId: row!.requirementId, iterationId: row!.iterationId },
    });
    const [view] = await hydrateTasks(tx, actor, [row!], opts.today ?? (await orgToday(tx, actor.orgId)));
    return view!;
  });
}

export async function updateTask(db: Db, actor: Actor, id: string, input: TaskPatch, opts: { today?: string } = {}): Promise<TaskView> {
  const { columns, meta } = normalize(input);
  return withOrg(db, actor.orgId, async (tx) => {
    const [peek] = await tx.select().from(tasks).where(eq(tasks.id, id));
    if (!peek) throw new AppError('not_found', TASK_NOT_FOUND);
    await requireTaskWrite(tx, actor, peek.productId);
    // 锁顺序与新建一致：先迭代（只在可能新增重点时才需要，用来串行化重点数校验）、后任务。
    if (columns.starred === true && peek.iterationId) await loadIteration(tx, peek.iterationId, 'update');
    const [cur] = await tx.select().from(tasks).where(eq(tasks.id, id)).for('update');
    if (!cur) throw new AppError('not_found', TASK_NOT_FOUND);
    if (columns.assigneeMemberId && columns.assigneeMemberId !== cur.assigneeMemberId) await assertMemberInOrg(tx, columns.assigneeMemberId);
    if (columns.starred === true && !cur.starred) {
      if (!cur.iterationId) throw new AppError('invalid', '只有迭代里的任务可以标为重点');
      await assertStarredRoom(tx, cur.iterationId);
    }
    const changes: Change[] = [];
    for (const [field, value] of Object.entries(columns) as Array<[keyof Columns, unknown]>) {
      const old = field === 'starred' ? (cur.starred ?? false) : cur[field];
      if (old !== value) changes.push({ field, old, new: value });
    }
    const nextMeta: Record<string, unknown> = { ...cur.meta };
    for (const [field, value] of Object.entries(meta) as Array<[keyof MetaPatch, string | number | null]>) {
      const old = cur.meta[field] ?? null;
      if (old !== value) changes.push({ field, old, new: value });
      if (value === null) delete nextMeta[field];
      else nextMeta[field] = value;
    }
    let row = cur;
    if (changes.length > 0) {
      [row] = (await tx.update(tasks).set({ ...columns, meta: nextMeta, updatedAt: new Date() }).where(eq(tasks.id, id)).returning()) as [TaskRow];
      await recordEvent(tx, { orgId: actor.orgId, productId: cur.productId, type: 'task.updated', subjectType: 'task', subjectId: id, actor, payload: { changes } });
    }
    const [view] = await hydrateTasks(tx, actor, [row], opts.today ?? (await orgToday(tx, actor.orgId)));
    return view!;
  });
}

export async function deleteTask(db: Db, actor: Actor, id: string): Promise<void> {
  return withOrg(db, actor.orgId, async (tx) => {
    const [cur] = await tx.select().from(tasks).where(eq(tasks.id, id)).for('update');
    if (!cur) throw new AppError('not_found', TASK_NOT_FOUND);
    await requireTaskWrite(tx, actor, cur.productId);
    await tx.delete(tasks).where(eq(tasks.id, id));
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: cur.productId,
      type: 'task.deleted',
      subjectType: 'task',
      subjectId: id,
      actor,
      payload: { title: cur.title, requirementId: cur.requirementId, iterationId: cur.iterationId },
    });
  });
}
