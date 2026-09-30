import { eq } from 'drizzle-orm';
import { requireProductRole } from '../access/permissions';
import type { Db } from '../db/client';
import { functionTags, members, requirementAssignments, requirements } from '../db/schema';
import { withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError, isUniqueViolation } from '../errors';
import { recordEvent } from '../events';
import { effectiveFields, loadRequirement } from './context';

export type AssignmentInput = { memberId: string; functionTagId: string; platformOptionId?: string | null };

type AssignmentRow = typeof requirementAssignments.$inferSelect;
const snapshot = (a: Pick<AssignmentRow, 'memberId' | 'functionTagId' | 'platformOptionId'>) => ({
  memberId: a.memberId,
  functionTagId: a.functionTagId,
  platformOptionId: a.platformOptionId,
});

/** 给需求分配某职能的负责成员（可限定平台）。分配决定会签检查项的「等我签字」推给谁。 */
export async function addRequirementAssignment(db: Db, actor: Actor, requirementId: string, input: AssignmentInput): Promise<{ id: string }> {
  return withOrg(db, actor.orgId, async (tx) => {
    const req = await loadRequirement(tx, requirementId);
    await requireProductRole(tx, actor, req.productId, 'editor');
    const [member] = await tx.select({ status: members.status }).from(members).where(eq(members.id, input.memberId));
    if (!member || member.status !== 'active') throw new AppError('invalid', '只能分配给在职成员');
    const [tag] = await tx.select({ id: functionTags.id }).from(functionTags).where(eq(functionTags.id, input.functionTagId));
    if (!tag) throw new AppError('invalid', '职能标签不存在');
    const platformOptionId = input.platformOptionId ?? null;
    if (platformOptionId) {
      const platform = (await effectiveFields(tx, req.productId)).get('platform');
      if (!platform?.options.some((o) => o.id === platformOptionId)) throw new AppError('invalid', '平台选项不属于本产品的「平台」字段');
    }
    let row: AssignmentRow;
    try {
      [row] = (await tx
        .insert(requirementAssignments)
        .values({ orgId: actor.orgId, requirementId, memberId: input.memberId, functionTagId: input.functionTagId, platformOptionId })
        .returning()) as [AssignmentRow];
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppError('conflict', '已经有相同的分配');
      throw e;
    }
    await tx.update(requirements).set({ updatedAt: new Date() }).where(eq(requirements.id, requirementId));
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: req.productId,
      type: 'requirement.assignment_added',
      subjectType: 'requirement',
      subjectId: requirementId,
      actor,
      payload: { assignmentId: row.id, changes: [{ field: 'assignments', old: null, new: snapshot(row) }] },
    });
    return { id: row.id };
  });
}

export async function removeRequirementAssignment(db: Db, actor: Actor, assignmentId: string): Promise<void> {
  return withOrg(db, actor.orgId, async (tx) => {
    const [cur] = await tx.select().from(requirementAssignments).where(eq(requirementAssignments.id, assignmentId)).for('update');
    if (!cur) throw new AppError('not_found', '分配不存在');
    const req = await loadRequirement(tx, cur.requirementId);
    await requireProductRole(tx, actor, req.productId, 'editor');
    await tx.delete(requirementAssignments).where(eq(requirementAssignments.id, assignmentId));
    await tx.update(requirements).set({ updatedAt: new Date() }).where(eq(requirements.id, req.id));
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: req.productId,
      type: 'requirement.assignment_removed',
      subjectType: 'requirement',
      subjectId: req.id,
      actor,
      payload: { assignmentId, changes: [{ field: 'assignments', old: snapshot(cur), new: null }] },
    });
  });
}
