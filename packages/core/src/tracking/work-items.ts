/**
 * 工作项（P3-C1）：不占需求编号的工作（技术支持、协调对接等），按组织编号 W-n，可选关联一个产品。
 * 权限见 access.ts；每个写操作在同一事务内记领域事件。删除为软删除。
 */
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { requireProductRole } from '../access/permissions';
import { assertIsoDate } from '../dates';
import type { Db } from '../db/client';
import { blockers, fieldDefinitions, fieldOptions, fieldValues, organizations, products, WORK_ITEM_STATUSES, workItems } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import { mentionedMemberIds, newMentionIds, parseWorkItemKey, workItemDisplayKey } from '../links/syntax';
import type { BlockerView } from '../requirements/blockers';
import { assertAssignableMember, memberNames } from '../requirements/context';
import { assertTitle, type MemberRef, type OptionRef } from '../requirements/requirements';
import { canEditAt, loadWorkItemTx, requireWorkItemAccess, type WorkItemAccess, workItemAccessTx, type WorkItemRow } from './access';
import { assertPauseReason } from './requirement-tracking';

export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];
export const WORK_ITEM_STATUS_LABELS: Record<WorkItemStatus, string> = { active: '进行中', done: '已完成', canceled: '已取消' };

export type WorkItemDetail = {
  id: string;
  number: number;
  displayKey: string;
  product: { id: string; key: string; name: string } | null;
  title: string;
  /** Markdown，可以 @ 成员。 */
  description: string;
  owner: MemberRef | null;
  createdBy: MemberRef | null;
  workType: OptionRef | null;
  status: WorkItemStatus;
  startedOn: string | null;
  expectedDate: string | null;
  doneAt: Date | null;
  paused: { at: Date; reason: string } | null;
  createdAt: Date;
  updatedAt: Date;
  /** 当前用户对它的权限：查看、修改、写进展与挂阻塞项、管理（删除别人的进展）。 */
  access: WorkItemAccess;
  blockers: BlockerView[];
};

export type WorkItemInput = {
  title: string;
  description?: string;
  productId?: string | null;
  ownerMemberId?: string | null;
  workTypeOptionId?: string | null;
  startedOn?: string | null;
  expectedDate?: string | null;
};
export type WorkItemPatch = Partial<WorkItemInput>;

function assertDescription(d: string): string {
  if (d.length > 50_000) throw new AppError('invalid', '描述不超过 50000 个字符');
  return d;
}

const dateOrNull = (v: string | null | undefined, label: string): string | null => (v ? assertIsoDate(v, label) : null);

/** 组织级内置字段「工作类型」及其选项；组织没有这个字段时为 null。 */
async function workTypeField(tx: Tx) {
  const [field] = await tx
    .select()
    .from(fieldDefinitions)
    .where(and(eq(fieldDefinitions.key, 'work_type'), isNull(fieldDefinitions.productId), eq(fieldDefinitions.appliesTo, 'work_item')));
  if (!field) return null;
  const options = await tx.select().from(fieldOptions).where(eq(fieldOptions.fieldId, field.id)).orderBy(asc(fieldOptions.sort));
  return { field, options };
}

/** 校验工作类型选项：属于「工作类型」字段，且未停用（停用但等于原值时放行）。 */
async function assertWorkType(tx: Tx, optionId: string, previous: string | null): Promise<{ fieldId: string; label: string }> {
  const wt = await workTypeField(tx);
  const option = wt?.options.find((o) => o.id === optionId);
  if (!wt || !option) throw new AppError('invalid', '选项不属于「工作类型」');
  if (!option.active && optionId !== previous) throw new AppError('invalid', `选项「${option.label}」已停用`);
  return { fieldId: wt.field.id, label: option.label };
}

async function currentWorkType(tx: Tx, itemId: string): Promise<OptionRef | null> {
  const [v] = await tx
    .select({ id: fieldOptions.id, key: fieldOptions.key, label: fieldOptions.label, color: fieldOptions.color })
    .from(fieldValues)
    .innerJoin(fieldDefinitions, eq(fieldDefinitions.id, fieldValues.fieldId))
    .innerJoin(fieldOptions, eq(fieldOptions.id, fieldValues.optionId))
    .where(and(eq(fieldValues.entityType, 'work_item'), eq(fieldValues.entityId, itemId), eq(fieldDefinitions.key, 'work_type')));
  return v ?? null;
}

async function writeWorkType(tx: Tx, orgId: string, itemId: string, fieldId: string, optionId: string | null): Promise<void> {
  await tx.delete(fieldValues).where(and(eq(fieldValues.entityId, itemId), eq(fieldValues.fieldId, fieldId)));
  if (optionId) await tx.insert(fieldValues).values({ orgId, entityType: 'work_item', entityId: itemId, fieldId, optionId });
}

async function detailTx(tx: Tx, actor: Actor, row: WorkItemRow): Promise<WorkItemDetail> {
  const access = await workItemAccessTx(tx, actor, row);
  const [product] = row.productId
    ? await tx.select({ id: products.id, key: products.key, name: products.name }).from(products).where(eq(products.id, row.productId))
    : [];
  const blockerRows = await tx.select().from(blockers).where(eq(blockers.workItemId, row.id)).orderBy(asc(blockers.createdAt));
  const names = await memberNames(tx, [row.ownerMemberId, row.createdBy, ...blockerRows.map((b) => b.ownerMemberId)]);
  const ref = (id: string | null): MemberRef | null => (id ? { id, displayName: names.get(id) ?? '已删除的成员' } : null);
  return {
    id: row.id,
    number: row.number,
    displayKey: workItemDisplayKey(row.number),
    product: product ?? null,
    title: row.title,
    description: row.description,
    owner: ref(row.ownerMemberId),
    createdBy: ref(row.createdBy),
    workType: await currentWorkType(tx, row.id),
    status: row.status,
    startedOn: row.startedOn,
    expectedDate: row.expectedDate,
    doneAt: row.doneAt,
    paused: row.pausedAt ? { at: row.pausedAt, reason: row.pauseReason ?? '' } : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    access,
    blockers: blockerRows.map((b) => ({ id: b.id, description: b.description, status: b.status, owner: ref(b.ownerMemberId), createdAt: b.createdAt, resolvedAt: b.resolvedAt })),
  };
}

export async function createWorkItem(db: Db, actor: Actor, input: WorkItemInput): Promise<WorkItemDetail> {
  const title = assertTitle(input.title);
  const description = assertDescription(input.description ?? '');
  const startedOn = dateOrNull(input.startedOn, '启动日期');
  const expectedDate = dateOrNull(input.expectedDate, '预计完成日期');
  return withOrg(db, actor.orgId, async (tx) => {
    const productId = input.productId ?? null;
    if (productId) await requireProductRole(tx, actor, productId, 'editor');
    else if (!(await canEditAt(tx, actor, null, { ownerMemberId: null, createdBy: actor.memberId }))) throw new AppError('forbidden', '没有新建工作项的权限');
    if (input.ownerMemberId) await assertAssignableMember(tx, input.ownerMemberId);
    const workType = input.workTypeOptionId ? await assertWorkType(tx, input.workTypeOptionId, null) : null;
    const [seq] = await tx
      .update(organizations)
      .set({ workItemSeq: sql`${organizations.workItemSeq} + 1` })
      .where(eq(organizations.id, actor.orgId))
      .returning({ n: organizations.workItemSeq });
    const [row] = await tx
      .insert(workItems)
      .values({ orgId: actor.orgId, productId, number: seq!.n, title, description, ownerMemberId: input.ownerMemberId ?? null, startedOn, expectedDate, createdBy: actor.memberId })
      .returning();
    if (workType) await writeWorkType(tx, actor.orgId, row!.id, workType.fieldId, input.workTypeOptionId!);
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId,
      type: 'work_item.created',
      subjectType: 'work_item',
      subjectId: row!.id,
      actor,
      payload: { number: row!.number, title, ownerMemberId: row!.ownerMemberId, mentionedMemberIds: mentionedMemberIds(description) },
    });
    return detailTx(tx, actor, row!);
  });
}

export async function getWorkItemByKey(db: Db, actor: Actor, key: string): Promise<WorkItemDetail> {
  const number = parseWorkItemKey(key);
  return withOrg(db, actor.orgId, async (tx) => {
    const [row] = number === null ? [] : await tx.select().from(workItems).where(and(eq(workItems.number, number), isNull(workItems.deletedAt)));
    if (!row) throw new AppError('not_found', '工作项不存在');
    await requireWorkItemAccess(tx, actor, row, 'view');
    return detailTx(tx, actor, row);
  });
}

/**
 * 修改字段。改关联产品时目标位置也要有修改权限：移到产品需要该产品编辑及以上；改为不关联产品需要是
 * 负责人、创建人或组织管理员（按修改之前的负责人与创建人判断）。
 */
export async function updateWorkItem(db: Db, actor: Actor, id: string, input: WorkItemPatch): Promise<WorkItemDetail> {
  return withOrg(db, actor.orgId, async (tx) => {
    const cur = await loadWorkItemTx(tx, id, true);
    await requireWorkItemAccess(tx, actor, cur, 'edit');
    const next = {
      title: input.title === undefined ? cur.title : assertTitle(input.title),
      description: input.description === undefined ? cur.description : assertDescription(input.description),
      productId: input.productId === undefined ? cur.productId : input.productId,
      ownerMemberId: input.ownerMemberId === undefined ? cur.ownerMemberId : input.ownerMemberId,
      startedOn: input.startedOn === undefined ? cur.startedOn : dateOrNull(input.startedOn, '启动日期'),
      expectedDate: input.expectedDate === undefined ? cur.expectedDate : dateOrNull(input.expectedDate, '预计完成日期'),
    };
    if (next.productId !== cur.productId) {
      if (next.productId) await requireProductRole(tx, actor, next.productId, 'editor');
      else if (!(await canEditAt(tx, actor, null, cur))) throw new AppError('forbidden', '只有负责人、创建人或组织管理员可以把工作项改为不关联产品');
    }
    if (next.ownerMemberId && next.ownerMemberId !== cur.ownerMemberId) await assertAssignableMember(tx, next.ownerMemberId);
    const changes: Array<{ field: string; old: unknown; new: unknown }> = (Object.keys(next) as Array<keyof typeof next>)
      .map((field) => ({ field, old: cur[field], new: next[field] }))
      .filter((c) => c.old !== c.new);
    if (input.workTypeOptionId !== undefined) {
      const before = await currentWorkType(tx, id);
      if ((before?.id ?? null) !== input.workTypeOptionId) {
        const picked = input.workTypeOptionId ? await assertWorkType(tx, input.workTypeOptionId, before?.id ?? null) : null;
        const fieldId = picked?.fieldId ?? (await workTypeField(tx))?.field.id;
        if (fieldId) await writeWorkType(tx, actor.orgId, id, fieldId, input.workTypeOptionId);
        changes.push({ field: 'workType', old: before?.label ?? null, new: picked?.label ?? null });
      }
    }
    if (changes.length === 0) return detailTx(tx, actor, cur);
    const [row] = await tx.update(workItems).set({ ...next, updatedAt: new Date() }).where(eq(workItems.id, id)).returning();
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: next.productId,
      type: 'work_item.updated',
      subjectType: 'work_item',
      subjectId: id,
      actor,
      payload: { changes, ...(next.description !== cur.description ? { mentionedMemberIds: newMentionIds(cur.description, next.description) } : {}) },
    });
    return detailTx(tx, actor, row!);
  });
}

/** 改状态：改成 done 时记完成时间，改成其他状态时清空；暂停标记不动。 */
export async function setWorkItemStatus(db: Db, actor: Actor, id: string, status: WorkItemStatus): Promise<WorkItemDetail> {
  if (!(WORK_ITEM_STATUSES as readonly string[]).includes(status)) throw new AppError('invalid', '状态无效');
  return withOrg(db, actor.orgId, async (tx) => {
    const cur = await loadWorkItemTx(tx, id, true);
    await requireWorkItemAccess(tx, actor, cur, 'edit');
    if (cur.status === status) throw new AppError('invalid', '工作项已处于该状态');
    const now = new Date();
    const [row] = await tx.update(workItems).set({ status, doneAt: status === 'done' ? now : null, updatedAt: now }).where(eq(workItems.id, id)).returning();
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: cur.productId,
      type: 'work_item.status_changed',
      subjectType: 'work_item',
      subjectId: id,
      actor,
      payload: { changes: [{ field: 'status', old: cur.status, new: status }] },
    });
    return detailTx(tx, actor, row!);
  });
}

/** 暂停：只有进行中的工作项可以暂停；已在暂停时报错，不写重复的暂停事件。 */
export async function pauseWorkItem(db: Db, actor: Actor, id: string, input: { reason: string }): Promise<WorkItemDetail> {
  const reason = assertPauseReason(input.reason);
  return withOrg(db, actor.orgId, async (tx) => {
    const cur = await loadWorkItemTx(tx, id, true);
    await requireWorkItemAccess(tx, actor, cur, 'edit');
    if (cur.status !== 'active') throw new AppError('invalid', '只有进行中的工作项可以暂停');
    if (cur.pausedAt) throw new AppError('invalid', '工作项已暂停');
    const now = new Date();
    const [row] = await tx.update(workItems).set({ pausedAt: now, pauseReason: reason, updatedAt: now }).where(eq(workItems.id, id)).returning();
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: cur.productId,
      type: 'work_item.paused',
      subjectType: 'work_item',
      subjectId: id,
      actor,
      payload: { reason, changes: [{ field: 'paused', old: false, new: true }] },
    });
    return detailTx(tx, actor, row!);
  });
}

/** 恢复：只要求正在暂停（已完成的工作项也可以恢复）。 */
export async function resumeWorkItem(db: Db, actor: Actor, id: string): Promise<WorkItemDetail> {
  return withOrg(db, actor.orgId, async (tx) => {
    const cur = await loadWorkItemTx(tx, id, true);
    await requireWorkItemAccess(tx, actor, cur, 'edit');
    if (!cur.pausedAt) throw new AppError('invalid', '工作项没有暂停');
    const now = new Date();
    const [row] = await tx.update(workItems).set({ pausedAt: null, pauseReason: null, updatedAt: now }).where(eq(workItems.id, id)).returning();
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: cur.productId,
      type: 'work_item.resumed',
      subjectType: 'work_item',
      subjectId: id,
      actor,
      payload: { pausedAt: cur.pausedAt.toISOString(), changes: [{ field: 'paused', old: true, new: false }] },
    });
    return detailTx(tx, actor, row!);
  });
}

export async function deleteWorkItem(db: Db, actor: Actor, id: string): Promise<void> {
  await withOrg(db, actor.orgId, async (tx) => {
    const cur = await loadWorkItemTx(tx, id, true);
    await requireWorkItemAccess(tx, actor, cur, 'edit');
    await tx.update(workItems).set({ deletedAt: new Date() }).where(eq(workItems.id, id));
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: cur.productId,
      type: 'work_item.deleted',
      subjectType: 'work_item',
      subjectId: id,
      actor,
      payload: { number: cur.number, title: cur.title },
    });
  });
}
