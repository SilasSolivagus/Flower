import { eq } from 'drizzle-orm';
import { requireProductRole } from '../access/permissions';
import type { Db } from '../db/client';
import { blockers, requirements, workItems } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import { loadWorkItemTx, requireWorkItemAccess } from '../tracking/access';
import { assertAssignableMember, loadRequirement, memberNames } from './context';
import type { MemberRef } from './requirements';

export type BlockerView = {
  id: string;
  description: string;
  status: 'active' | 'resolved';
  owner: MemberRef | null;
  createdAt: Date;
  resolvedAt: Date | null;
};

type BlockerRow = typeof blockers.$inferSelect;

function assertDescription(v: string): string {
  const d = v.trim();
  if (!d || d.length > 500) throw new AppError('invalid', '阻塞描述不能为空，且不超过 500 个字符');
  return d;
}

async function toView(tx: Tx, row: BlockerRow): Promise<BlockerView> {
  const names = await memberNames(tx, [row.ownerMemberId]);
  return {
    id: row.id,
    description: row.description,
    status: row.status,
    owner: row.ownerMemberId ? { id: row.ownerMemberId, displayName: names.get(row.ownerMemberId) ?? '已删除的成员' } : null,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
  };
}

export async function createBlocker(
  db: Db,
  actor: Actor,
  requirementId: string,
  input: { description: string; ownerMemberId?: string | null },
): Promise<BlockerView> {
  const description = assertDescription(input.description);
  return withOrg(db, actor.orgId, async (tx) => {
    const req = await loadRequirement(tx, requirementId);
    await requireProductRole(tx, actor, req.productId, 'editor');
    if (input.ownerMemberId) await assertAssignableMember(tx, input.ownerMemberId);
    const [row] = await tx
      .insert(blockers)
      .values({ orgId: actor.orgId, requirementId, description, ownerMemberId: input.ownerMemberId ?? null })
      .returning();
    await tx.update(requirements).set({ updatedAt: new Date() }).where(eq(requirements.id, requirementId));
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: req.productId,
      type: 'blocker.created',
      subjectType: 'requirement',
      subjectId: requirementId,
      actor,
      payload: { blockerId: row!.id, description },
    });
    return toView(tx, row!);
  });
}

/** 工作项上的阻塞项：能写进展的人可以新建（P3-C1）。事件挂在工作项上。 */
export async function createWorkItemBlocker(
  db: Db,
  actor: Actor,
  workItemId: string,
  input: { description: string; ownerMemberId?: string | null },
): Promise<BlockerView> {
  const description = assertDescription(input.description);
  return withOrg(db, actor.orgId, async (tx) => {
    const item = await loadWorkItemTx(tx, workItemId, true);
    await requireWorkItemAccess(tx, actor, item, 'progress');
    if (input.ownerMemberId) await assertAssignableMember(tx, input.ownerMemberId);
    const [row] = await tx
      .insert(blockers)
      .values({ orgId: actor.orgId, workItemId, description, ownerMemberId: input.ownerMemberId ?? null })
      .returning();
    await tx.update(workItems).set({ updatedAt: new Date() }).where(eq(workItems.id, workItemId));
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: item.productId,
      type: 'blocker.created',
      subjectType: 'work_item',
      subjectId: workItemId,
      actor,
      payload: { blockerId: row!.id, description },
    });
    return toView(tx, row!);
  });
}

/** 解除阻塞项：需求上的要求产品编辑及以上；工作项上的要求能写进展。事件挂在所属对象上。 */
export async function resolveBlocker(db: Db, actor: Actor, blockerId: string): Promise<BlockerView> {
  return withOrg(db, actor.orgId, async (tx) => {
    const [cur] = await tx.select().from(blockers).where(eq(blockers.id, blockerId)).for('update');
    if (!cur) throw new AppError('not_found', '阻塞项不存在');
    let subject: { type: 'requirement' | 'work_item'; id: string; productId: string | null };
    if (cur.workItemId) {
      const item = await loadWorkItemTx(tx, cur.workItemId);
      await requireWorkItemAccess(tx, actor, item, 'progress');
      subject = { type: 'work_item', id: item.id, productId: item.productId };
    } else {
      const req = await loadRequirement(tx, cur.requirementId!);
      await requireProductRole(tx, actor, req.productId, 'editor');
      subject = { type: 'requirement', id: req.id, productId: req.productId };
    }
    if (cur.status === 'resolved') throw new AppError('invalid', '该阻塞项已解除');
    const now = new Date();
    const [row] = await tx.update(blockers).set({ status: 'resolved', resolvedAt: now }).where(eq(blockers.id, blockerId)).returning();
    if (subject.type === 'work_item') await tx.update(workItems).set({ updatedAt: now }).where(eq(workItems.id, subject.id));
    else await tx.update(requirements).set({ updatedAt: now }).where(eq(requirements.id, subject.id));
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: subject.productId,
      type: 'blocker.resolved',
      subjectType: subject.type,
      subjectId: subject.id,
      actor,
      payload: { blockerId, changes: [{ field: 'status', old: 'active', new: 'resolved' }] },
    });
    return toView(tx, row!);
  });
}
