/**
 * 进展记录（P3-C1）：挂在需求或工作项上，按条保存进展、下一步与跟进人；列表显示最新一条。
 * 写：需求为产品编辑及以上，工作项见 access.ts 的 progress。作者本人（且仍能写）可以修改、删除；
 * 产品管理员（不关联产品时为组织管理员）可以删除别人的。删除为软删除。
 */
import { and, desc, eq, isNull } from 'drizzle-orm';
import { atLeast, productRoleOf } from '../access/permissions';
import { assertIsoDate } from '../dates';
import type { Db } from '../db/client';
import { progressUpdates, requirements, workItems } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import { assertAssignableMember, loadRequirementForUpdate, memberNames } from '../requirements/context';
import type { MemberRef } from '../requirements/requirements';
import { loadWorkItemTx, requireWorkItemAccess, workItemAccessTx } from './access';
import { setExpectedDateTx } from './requirement-tracking';

export type ProgressSubject = { type: 'requirement' | 'work_item'; id: string };
export type ProgressView = {
  id: string;
  body: string;
  nextStep: string | null;
  follower: MemberRef | null;
  author: MemberRef | null;
  createdAt: Date;
  editedAt: Date | null;
  /** 当前用户能否修改、删除这一条。 */
  canEdit: boolean;
  canDelete: boolean;
};
export type ProgressEntryInput = { body: string; nextStep?: string | null; followerMemberId?: string | null; expectedDate?: string | null };
export type ProgressPatch = { body?: string; nextStep?: string | null; followerMemberId?: string | null };

type ProgressRow = typeof progressUpdates.$inferSelect;
type Rights = { productId: string | null; write: boolean; manage: boolean };

function assertBody(v: string): string {
  const b = v.trim();
  if (!b || b.length > 2000) throw new AppError('invalid', '进展不能为空，且不超过 2000 个字符');
  return b;
}

function assertNextStep(v: string | null | undefined): string | null {
  const s = v?.trim() ?? '';
  if (s.length > 500) throw new AppError('invalid', '下一步不超过 500 个字符');
  return s || null;
}

/** 所属对象的产品与当前用户的写、管理权限；对象不存在、已删除或看不到时报「不存在」。 */
async function rightsTx(tx: Tx, actor: Actor, s: ProgressSubject): Promise<Rights> {
  if (s.type === 'requirement') {
    const [r] = await tx.select({ productId: requirements.productId }).from(requirements).where(and(eq(requirements.id, s.id), isNull(requirements.deletedAt)));
    const role = r ? await productRoleOf(tx, actor, r.productId) : null;
    if (!r || !role) throw new AppError('not_found', '需求不存在');
    return { productId: r.productId, write: atLeast(role, 'editor'), manage: role === 'admin' };
  }
  const item = await loadWorkItemTx(tx, s.id);
  const access = await workItemAccessTx(tx, actor, item);
  if (!access.view) throw new AppError('not_found', '工作项不存在');
  return { productId: item.productId, write: access.progress, manage: access.manage };
}

const subjectOf = (row: ProgressRow): ProgressSubject =>
  row.requirementId ? { type: 'requirement', id: row.requirementId } : { type: 'work_item', id: row.workItemId! };

async function viewsTx(tx: Tx, actor: Actor, rows: ProgressRow[], rights: Rights): Promise<ProgressView[]> {
  const names = await memberNames(tx, rows.flatMap((r) => [r.followerMemberId, r.authorMemberId]));
  const ref = (id: string | null): MemberRef | null => (id ? { id, displayName: names.get(id) ?? '已删除的成员' } : null);
  return rows.map((r) => {
    const mine = rights.write && r.authorMemberId === actor.memberId;
    return {
      id: r.id,
      body: r.body,
      nextStep: r.nextStep,
      follower: ref(r.followerMemberId),
      author: ref(r.authorMemberId),
      createdAt: r.createdAt,
      editedAt: r.editedAt,
      canEdit: mine,
      canDelete: mine || rights.manage,
    };
  });
}

/** 写进展时顺手改预计日期：需求为预计上线日期（产品编辑即可），工作项为预计完成日期（需要修改权限）。 */
async function changeExpectedTx(tx: Tx, actor: Actor, s: ProgressSubject, next: string | null): Promise<void> {
  if (s.type === 'requirement') {
    await setExpectedDateTx(tx, actor, await loadRequirementForUpdate(tx, s.id), next);
    return;
  }
  const item = await loadWorkItemTx(tx, s.id, true);
  await requireWorkItemAccess(tx, actor, item, 'edit');
  if (item.expectedDate === next) return;
  await tx.update(workItems).set({ expectedDate: next, updatedAt: new Date() }).where(eq(workItems.id, item.id));
  await recordEvent(tx, {
    orgId: actor.orgId,
    productId: item.productId,
    type: 'work_item.updated',
    subjectType: 'work_item',
    subjectId: item.id,
    actor,
    payload: { changes: [{ field: 'expectedDate', old: item.expectedDate, new: next }] },
  });
}

async function loadProgressTx(tx: Tx, id: string): Promise<ProgressRow> {
  const [row] = await tx.select().from(progressUpdates).where(and(eq(progressUpdates.id, id), isNull(progressUpdates.deletedAt))).for('update');
  if (!row) throw new AppError('not_found', '进展记录不存在');
  return row;
}

export async function listProgress(db: Db, actor: Actor, subject: ProgressSubject): Promise<ProgressView[]> {
  return withOrg(db, actor.orgId, async (tx) => {
    const rights = await rightsTx(tx, actor, subject);
    const column = subject.type === 'requirement' ? progressUpdates.requirementId : progressUpdates.workItemId;
    const rows = await tx
      .select()
      .from(progressUpdates)
      .where(and(eq(column, subject.id), isNull(progressUpdates.deletedAt)))
      .orderBy(desc(progressUpdates.createdAt), desc(progressUpdates.id));
    return viewsTx(tx, actor, rows, rights);
  });
}

export async function createProgress(db: Db, actor: Actor, subject: ProgressSubject, input: ProgressEntryInput): Promise<ProgressView> {
  const body = assertBody(input.body);
  const nextStep = assertNextStep(input.nextStep);
  const label = subject.type === 'requirement' ? '预计上线日期' : '预计完成日期';
  const expected = input.expectedDate === undefined ? undefined : input.expectedDate === null ? null : assertIsoDate(input.expectedDate, label);
  return withOrg(db, actor.orgId, async (tx) => {
    const rights = await rightsTx(tx, actor, subject);
    if (!rights.write) throw new AppError('forbidden', '权限不足');
    if (input.followerMemberId) await assertAssignableMember(tx, input.followerMemberId);
    const [row] = await tx
      .insert(progressUpdates)
      .values({
        orgId: actor.orgId,
        requirementId: subject.type === 'requirement' ? subject.id : null,
        workItemId: subject.type === 'work_item' ? subject.id : null,
        body,
        nextStep,
        followerMemberId: input.followerMemberId ?? null,
        authorMemberId: actor.memberId,
      })
      .returning();
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: rights.productId,
      type: 'progress.created',
      subjectType: subject.type,
      subjectId: subject.id,
      actor,
      payload: { progressId: row!.id, followerMemberId: row!.followerMemberId, nextStep },
    });
    if (expected !== undefined) await changeExpectedTx(tx, actor, subject, expected);
    return (await viewsTx(tx, actor, [row!], rights))[0]!;
  });
}

export async function updateProgress(db: Db, actor: Actor, progressId: string, input: ProgressPatch): Promise<ProgressView> {
  return withOrg(db, actor.orgId, async (tx) => {
    const cur = await loadProgressTx(tx, progressId);
    const subject = subjectOf(cur);
    const rights = await rightsTx(tx, actor, subject);
    if (!rights.write || cur.authorMemberId !== actor.memberId) throw new AppError('forbidden', '只能修改自己写的进展');
    const next = {
      body: input.body === undefined ? cur.body : assertBody(input.body),
      nextStep: input.nextStep === undefined ? cur.nextStep : assertNextStep(input.nextStep),
      followerMemberId: input.followerMemberId === undefined ? cur.followerMemberId : input.followerMemberId,
    };
    if (next.followerMemberId && next.followerMemberId !== cur.followerMemberId) await assertAssignableMember(tx, next.followerMemberId);
    const changes = (Object.keys(next) as Array<keyof typeof next>).map((field) => ({ field, old: cur[field], new: next[field] })).filter((c) => c.old !== c.new);
    if (changes.length === 0) return (await viewsTx(tx, actor, [cur], rights))[0]!;
    const [row] = await tx.update(progressUpdates).set({ ...next, editedAt: new Date() }).where(eq(progressUpdates.id, progressId)).returning();
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: rights.productId,
      type: 'progress.updated',
      subjectType: subject.type,
      subjectId: subject.id,
      actor,
      payload: { progressId, changes },
    });
    return (await viewsTx(tx, actor, [row!], rights))[0]!;
  });
}

export async function deleteProgress(db: Db, actor: Actor, progressId: string): Promise<void> {
  await withOrg(db, actor.orgId, async (tx) => {
    const cur = await loadProgressTx(tx, progressId);
    const subject = subjectOf(cur);
    const rights = await rightsTx(tx, actor, subject);
    if (!rights.manage && !(rights.write && cur.authorMemberId === actor.memberId)) throw new AppError('forbidden', '没有删除这条进展的权限');
    await tx.update(progressUpdates).set({ deletedAt: new Date() }).where(eq(progressUpdates.id, progressId));
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: rights.productId,
      type: 'progress.deleted',
      subjectType: subject.type,
      subjectId: subject.id,
      actor,
      payload: { progressId },
    });
  });
}
