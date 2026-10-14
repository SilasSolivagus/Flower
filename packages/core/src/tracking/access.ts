/**
 * 工作项的权限（P3-C1）。
 * 关联产品：查看 = 能看到该产品；修改、写进展、挂阻塞项 = 产品编辑及以上；管理（删除别人的进展）= 产品管理员。
 * 不关联产品：查看 = 非访客成员（Token 须为全部产品范围）；修改 = 负责人、创建人或组织管理员（只读 Token 不行）；
 * 写进展、挂阻塞项 = 能查看且非只读；管理 = 组织管理员。
 */
import { and, eq, isNull } from 'drizzle-orm';
import { atLeast, isOrgAdmin, productRoleOf } from '../access/permissions';
import { workItems } from '../db/schema';
import type { Tx } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError } from '../errors';

export type WorkItemRow = typeof workItems.$inferSelect;
export type WorkItemAccess = { view: boolean; edit: boolean; progress: boolean; manage: boolean };
type People = { ownerMemberId: string | null; createdBy: string | null };

const readOnly = (actor: Actor): boolean => actor.tokenScope?.access === 'read';

/** 能否看到不关联产品的工作项：非访客成员；用 Token 时须为全部产品范围。 */
export function canViewUnlinked(actor: Actor): boolean {
  return actor.orgRole !== 'guest' && (!actor.tokenScope || actor.tokenScope.products === 'all');
}

/** 能否在不关联产品的工作项上写进展、挂阻塞项，以及新建不关联产品的工作项。 */
export function canWriteUnlinked(actor: Actor): boolean {
  return canViewUnlinked(actor) && !readOnly(actor);
}

/** 能否修改不关联产品的工作项：可以写，且是组织管理员、负责人或创建人。 */
export function canEditUnlinked(actor: Actor, people: People): boolean {
  return canWriteUnlinked(actor) && (isOrgAdmin(actor) || people.ownerMemberId === actor.memberId || people.createdBy === actor.memberId);
}

/** 在某个位置（产品，或不关联产品）上能否修改这个工作项。改关联产品时，目标位置也要用它检查。 */
export async function canEditAt(tx: Tx, actor: Actor, productId: string | null, people: People): Promise<boolean> {
  if (productId) return atLeast(await productRoleOf(tx, actor, productId), 'editor');
  return canEditUnlinked(actor, people);
}

export async function workItemAccessTx(tx: Tx, actor: Actor, item: Pick<WorkItemRow, 'productId' | 'ownerMemberId' | 'createdBy'>): Promise<WorkItemAccess> {
  if (item.productId) {
    const role = await productRoleOf(tx, actor, item.productId);
    const edit = atLeast(role, 'editor');
    return { view: role !== null, edit, progress: edit, manage: role === 'admin' };
  }
  const view = canViewUnlinked(actor);
  return { view, edit: canEditUnlinked(actor, item), progress: canWriteUnlinked(actor), manage: view && isOrgAdmin(actor) };
}

/** 看不到时报「工作项不存在」，看得到但缺少所需权限时报 forbidden。 */
export async function requireWorkItemAccess(
  tx: Tx,
  actor: Actor,
  item: Pick<WorkItemRow, 'productId' | 'ownerMemberId' | 'createdBy'>,
  need: keyof WorkItemAccess,
): Promise<WorkItemAccess> {
  const access = await workItemAccessTx(tx, actor, item);
  if (!access.view) throw new AppError('not_found', '工作项不存在');
  if (!access[need]) {
    throw new AppError('forbidden', need === 'edit' && !item.productId ? '只有负责人、创建人或组织管理员可以修改这个工作项' : '权限不足');
  }
  return access;
}

/** 读取未删除的工作项；lock 为 true 时加行锁（状态、暂停、进展等写操作用，避免并发写出重复的事件）。 */
export async function loadWorkItemTx(tx: Tx, id: string, lock = false): Promise<WorkItemRow> {
  const where = and(eq(workItems.id, id), isNull(workItems.deletedAt));
  const [row] = lock ? await tx.select().from(workItems).where(where).for('update') : await tx.select().from(workItems).where(where);
  if (!row) throw new AppError('not_found', '工作项不存在');
  return row;
}
