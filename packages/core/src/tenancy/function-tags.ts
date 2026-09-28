import { asc, eq } from 'drizzle-orm';
import { requireNonGuest, requireOrgAdmin } from '../access/permissions';
import type { Db } from '../db/client';
import { functionTags } from '../db/schema';
import { withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError, isUniqueViolation } from '../errors';
import { recordEvent } from '../events';

export type FunctionTagView = { id: string; name: string; color: string; sort: number };

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function assertTag(input: { name?: string; color?: string }) {
  if (input.name !== undefined && (!input.name.trim() || input.name.trim().length > 20)) {
    throw new AppError('invalid', '标签名称不能为空，且不超过 20 个字符');
  }
  if (input.color !== undefined && !COLOR_RE.test(input.color)) throw new AppError('invalid', '颜色格式应为 #RRGGBB');
}

const view = (r: typeof functionTags.$inferSelect): FunctionTagView => ({ id: r.id, name: r.name, color: r.color, sort: r.sort });

export async function listFunctionTags(db: Db, actor: Actor): Promise<FunctionTagView[]> {
  requireNonGuest(actor);
  return withOrg(db, actor.orgId, async (tx) =>
    (await tx.select().from(functionTags).orderBy(asc(functionTags.sort), asc(functionTags.name))).map(view),
  );
}

export async function createFunctionTag(db: Db, actor: Actor, input: { name: string; color: string }): Promise<FunctionTagView> {
  requireOrgAdmin(actor);
  assertTag(input);
  return withOrg(db, actor.orgId, async (tx) => {
    const existing = await tx.select().from(functionTags);
    try {
      const [row] = await tx
        .insert(functionTags)
        .values({ orgId: actor.orgId, name: input.name.trim(), color: input.color, sort: existing.length })
        .returning();
      await recordEvent(tx, { orgId: actor.orgId, type: 'function_tag.created', subjectType: 'function_tag', subjectId: row!.id, actor, payload: { name: row!.name } });
      return view(row!);
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppError('conflict', '已存在同名标签');
      throw e;
    }
  });
}

export async function updateFunctionTag(
  db: Db,
  actor: Actor,
  id: string,
  input: { name?: string; color?: string; sort?: number },
): Promise<FunctionTagView> {
  requireOrgAdmin(actor);
  assertTag(input);
  return withOrg(db, actor.orgId, async (tx) => {
    const [cur] = await tx.select().from(functionTags).where(eq(functionTags.id, id));
    if (!cur) throw new AppError('not_found', '标签不存在');
    const name = input.name === undefined ? cur.name : input.name.trim();
    const color = input.color === undefined ? cur.color : input.color;
    const sort = input.sort === undefined ? cur.sort : input.sort;
    try {
      const [row] = await tx
        .update(functionTags)
        .set({ name, color, sort })
        .where(eq(functionTags.id, id))
        .returning();
      if (!row) throw new AppError('not_found', '标签不存在');
      await recordEvent(tx, {
        orgId: actor.orgId,
        type: 'function_tag.updated',
        subjectType: 'function_tag',
        subjectId: id,
        actor,
        payload: {
          changes: [
            { field: 'name', old: cur.name, new: name },
            { field: 'color', old: cur.color, new: color },
            { field: 'sort', old: cur.sort, new: sort },
          ].filter((c) => c.old !== c.new),
        },
      });
      return view(row);
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppError('conflict', '已存在同名标签');
      throw e;
    }
  });
}

export async function deleteFunctionTag(db: Db, actor: Actor, id: string): Promise<void> {
  requireOrgAdmin(actor);
  return withOrg(db, actor.orgId, async (tx) => {
    const [row] = await tx.delete(functionTags).where(eq(functionTags.id, id)).returning();
    if (!row) throw new AppError('not_found', '标签不存在');
    await recordEvent(tx, { orgId: actor.orgId, type: 'function_tag.deleted', subjectType: 'function_tag', subjectId: id, actor, payload: { name: row.name } });
  });
}
