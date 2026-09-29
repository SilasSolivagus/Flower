import { eq } from 'drizzle-orm';
import { atLeast, productRoleOf, requireProductRole } from '../access/permissions';
import type { Db } from '../db/client';
import { RELATION_TYPES, requirementRelations } from '../db/schema';
import { withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError, isUniqueViolation } from '../errors';
import { recordEvent } from '../events';
import { loadRequirement } from './context';

export type RelationType = (typeof RELATION_TYPES)[number];

export async function createRelation(db: Db, actor: Actor, input: { fromId: string; toId: string; type: RelationType }): Promise<{ id: string }> {
  if (!(RELATION_TYPES as readonly string[]).includes(input.type)) throw new AppError('invalid', '关联类型无效');
  if (input.fromId === input.toId) throw new AppError('invalid', '不能关联需求自身');
  return withOrg(db, actor.orgId, async (tx) => {
    const from = await loadRequirement(tx, input.fromId);
    await requireProductRole(tx, actor, from.productId, 'editor');
    // 其他组织的需求被 RLS 过滤，这里同样得到「需求不存在」
    const to = await loadRequirement(tx, input.toId);
    if (to.productId !== from.productId && !(await productRoleOf(tx, actor, to.productId))) throw new AppError('not_found', '需求不存在');
    let id: string;
    try {
      const [row] = await tx
        .insert(requirementRelations)
        .values({ orgId: actor.orgId, fromId: from.id, toId: to.id, type: input.type })
        .returning({ id: requirementRelations.id });
      id = row!.id;
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppError('conflict', '已存在相同的关联');
      throw e;
    }
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: from.productId,
      type: 'requirement.relation_added',
      subjectType: 'requirement',
      subjectId: from.id,
      actor,
      payload: { relationId: id, toId: to.id, type: input.type },
    });
    return { id };
  });
}

export async function deleteRelation(db: Db, actor: Actor, relationId: string): Promise<void> {
  return withOrg(db, actor.orgId, async (tx) => {
    const [rel] = await tx.select().from(requirementRelations).where(eq(requirementRelations.id, relationId));
    if (!rel) throw new AppError('not_found', '关联不存在');
    const from = await loadRequirement(tx, rel.fromId);
    const to = await loadRequirement(tx, rel.toId);
    const fromRole = await productRoleOf(tx, actor, from.productId);
    const toRole = await productRoleOf(tx, actor, to.productId);
    if (!fromRole || !toRole) throw new AppError('not_found', '关联不存在');
    if (!atLeast(fromRole, 'editor') && !atLeast(toRole, 'editor')) throw new AppError('forbidden', '权限不足');
    await tx.delete(requirementRelations).where(eq(requirementRelations.id, relationId));
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: from.productId,
      type: 'requirement.relation_removed',
      subjectType: 'requirement',
      subjectId: from.id,
      actor,
      payload: { relationId, toId: to.id, type: rel.type },
    });
  });
}
