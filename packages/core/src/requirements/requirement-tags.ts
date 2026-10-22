/**
 * 需求标签（M4-014）：组织级字典，和职能标签分开。挂到需求上是多对多，删除字典项时数据库级联卸挂。
 */
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { requireOrgAdmin, requireProductRole } from '../access/permissions';
import type { Db } from '../db/client';
import { requirementTagLinks, requirementTags } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError, isUniqueViolation } from '../errors';
import { recordEvent } from '../events';
import { loadRequirement } from './context';

export type RequirementTagView = { id: string; name: string; color: string; usageCount: number };
export type RequirementTagRef = { id: string; name: string; color: string };

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const DEFAULT_COLOR = '#64748b';

function assertName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 20) throw new AppError('invalid', '标签名称不能为空，且不超过 20 个字符');
  return trimmed;
}

function assertColor(color: string | undefined, fallback: string): string {
  if (color === undefined) return fallback;
  if (!COLOR_RE.test(color)) throw new AppError('invalid', '颜色格式应为 #RRGGBB');
  return color;
}

async function assertUniqueName(tx: Tx, name: string, exceptId?: string): Promise<void> {
  const [dup] = await tx
    .select({ id: requirementTags.id })
    .from(requirementTags)
    .where(sql`lower(${requirementTags.name}) = ${name.toLowerCase()}`);
  if (dup && dup.id !== exceptId) throw new AppError('invalid', '已存在同名需求标签');
}

export async function listRequirementTags(db: Db, actor: Actor): Promise<RequirementTagView[]> {
  return withOrg(db, actor.orgId, async (tx) => {
    const rows = await tx
      .select({
        id: requirementTags.id,
        name: requirementTags.name,
        color: requirementTags.color,
        usageCount: sql<number>`count(${requirementTagLinks.requirementId})::int`,
      })
      .from(requirementTags)
      .leftJoin(requirementTagLinks, eq(requirementTagLinks.tagId, requirementTags.id))
      .groupBy(requirementTags.id, requirementTags.name, requirementTags.color)
      .orderBy(asc(requirementTags.name));
    return rows;
  });
}

export async function createRequirementTag(db: Db, actor: Actor, input: { name: string; color?: string }): Promise<RequirementTagView> {
  requireOrgAdmin(actor);
  const name = assertName(input.name);
  const color = assertColor(input.color, DEFAULT_COLOR);
  return withOrg(db, actor.orgId, async (tx) => {
    await assertUniqueName(tx, name);
    try {
      const [row] = await tx.insert(requirementTags).values({ orgId: actor.orgId, name, color }).returning();
      await recordEvent(tx, {
        orgId: actor.orgId,
        type: 'requirement_tag.created',
        subjectType: 'requirement_tag',
        subjectId: row!.id,
        actor,
        payload: { name: row!.name, color: row!.color },
      });
      return { id: row!.id, name: row!.name, color: row!.color, usageCount: 0 };
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppError('invalid', '已存在同名需求标签');
      throw e;
    }
  });
}

export async function updateRequirementTag(
  db: Db,
  actor: Actor,
  id: string,
  input: { name?: string; color?: string },
): Promise<RequirementTagView> {
  requireOrgAdmin(actor);
  return withOrg(db, actor.orgId, async (tx) => {
    const [cur] = await tx.select().from(requirementTags).where(eq(requirementTags.id, id));
    if (!cur) throw new AppError('not_found', '标签不存在');
    const name = input.name === undefined ? cur.name : assertName(input.name);
    const color = assertColor(input.color, cur.color);
    await assertUniqueName(tx, name, id);
    try {
      const [row] = await tx.update(requirementTags).set({ name, color }).where(eq(requirementTags.id, id)).returning();
      if (!row) throw new AppError('not_found', '标签不存在');
      const [count] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(requirementTagLinks)
        .where(eq(requirementTagLinks.tagId, id));
      await recordEvent(tx, {
        orgId: actor.orgId,
        type: 'requirement_tag.updated',
        subjectType: 'requirement_tag',
        subjectId: id,
        actor,
        payload: {
          changes: [
            { field: 'name', old: cur.name, new: name },
            { field: 'color', old: cur.color, new: color },
          ].filter((c) => c.old !== c.new),
        },
      });
      return { id: row.id, name: row.name, color: row.color, usageCount: count?.n ?? 0 };
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppError('invalid', '已存在同名需求标签');
      throw e;
    }
  });
}

/** 删除字典项。仍挂在需求上时由外键级联卸挂，不返回 409。 */
export async function deleteRequirementTag(db: Db, actor: Actor, id: string): Promise<{ removedFrom: number }> {
  requireOrgAdmin(actor);
  return withOrg(db, actor.orgId, async (tx) => {
    const [cur] = await tx.select().from(requirementTags).where(eq(requirementTags.id, id));
    if (!cur) throw new AppError('not_found', '标签不存在');
    const [count] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(requirementTagLinks)
      .where(eq(requirementTagLinks.tagId, id));
    const removedFrom = count?.n ?? 0;
    await tx.delete(requirementTags).where(eq(requirementTags.id, id));
    await recordEvent(tx, {
      orgId: actor.orgId,
      type: 'requirement_tag.deleted',
      subjectType: 'requirement_tag',
      subjectId: id,
      actor,
      payload: { name: cur.name, removedFrom },
    });
    return { removedFrom };
  });
}

export async function requirementTagsTx(tx: Tx, requirementId: string): Promise<RequirementTagRef[]> {
  return tx
    .select({ id: requirementTags.id, name: requirementTags.name, color: requirementTags.color })
    .from(requirementTagLinks)
    .innerJoin(requirementTags, eq(requirementTags.id, requirementTagLinks.tagId))
    .where(eq(requirementTagLinks.requirementId, requirementId))
    .orderBy(asc(requirementTags.name));
}

/** 全量覆盖一条需求上的标签。标签必须属于同一组织，否则 404，不暴露是否存在于其他组织。 */
export async function setRequirementTags(db: Db, actor: Actor, requirementId: string, tagIds: string[]): Promise<RequirementTagRef[]> {
  const unique = [...new Set(tagIds)];
  return withOrg(db, actor.orgId, async (tx) => {
    const requirement = await loadRequirement(tx, requirementId);
    await requireProductRole(tx, actor, requirement.productId, 'editor');
    const found = unique.length
      ? await tx.select().from(requirementTags).where(inArray(requirementTags.id, unique))
      : [];
    if (found.length !== unique.length || found.some((t) => t.orgId !== requirement.orgId)) {
      throw new AppError('not_found', '标签不存在');
    }
    const current = await tx.select({ tagId: requirementTagLinks.tagId }).from(requirementTagLinks).where(eq(requirementTagLinks.requirementId, requirementId));
    const before = current.map((r) => r.tagId).sort();
    const after = [...unique].sort();
    const same = before.length === after.length && before.every((id, i) => id === after[i]);
    if (!same) {
      await tx.delete(requirementTagLinks).where(eq(requirementTagLinks.requirementId, requirementId));
      if (unique.length) {
        await tx.insert(requirementTagLinks).values(unique.map((tagId) => ({ orgId: actor.orgId, requirementId, tagId })));
      }
      await recordEvent(tx, {
        orgId: actor.orgId,
        productId: requirement.productId,
        type: 'requirement.tags_set',
        subjectType: 'requirement',
        subjectId: requirementId,
        actor,
        payload: { changes: [{ field: 'tags', old: before, new: after }] },
      });
    }
    return requirementTagsTx(tx, requirementId);
  });
}
