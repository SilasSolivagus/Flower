import { eq } from 'drizzle-orm';
import { requireNonGuest, requireOrgAdmin, requireProductRole } from '../access/permissions';
import type { Db } from '../db/client';
import { organizations, products } from '../db/schema';
import { withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import { DEFAULT_LEVEL_NAMES } from './defaults';

export function validateLevelNames(names: unknown): string[] {
  if (!Array.isArray(names) || names.length < 1 || names.length > 3) {
    throw new AppError('invalid', '层级数量为 1–3 层');
  }
  return names.map((n) => {
    const s = typeof n === 'string' ? n.trim() : '';
    if (!s || s.length > 10) throw new AppError('invalid', '每层名称不能为空，且不超过 10 个字符');
    return s;
  });
}

export async function getLevelNames(
  db: Db,
  actor: Actor,
  productId?: string,
): Promise<{ names: string[]; source: 'default' | 'org' | 'product' }> {
  return withOrg(db, actor.orgId, async (tx) => {
    if (productId) {
      await requireProductRole(tx, actor, productId, 'viewer');
      const [p] = await tx.select({ names: products.structureLevelNames }).from(products).where(eq(products.id, productId));
      if (p?.names) return { names: p.names, source: 'product' };
    } else {
      requireNonGuest(actor);
    }
    const [org] = await tx.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, actor.orgId));
    const names = org?.settings.structureLevelNames;
    return names ? { names, source: 'org' } : { names: DEFAULT_LEVEL_NAMES, source: 'default' };
  });
}

export async function setOrgLevelNames(db: Db, actor: Actor, names: string[]): Promise<string[]> {
  requireOrgAdmin(actor);
  const clean = validateLevelNames(names);
  return withOrg(db, actor.orgId, async (tx) => {
    const [org] = await tx.select().from(organizations).where(eq(organizations.id, actor.orgId));
    await tx
      .update(organizations)
      .set({ settings: { ...org!.settings, structureLevelNames: clean } })
      .where(eq(organizations.id, actor.orgId));
    await recordEvent(tx, {
      orgId: actor.orgId, type: 'organization.level_names_set', subjectType: 'organization', subjectId: actor.orgId, actor,
      payload: { changes: [{ field: 'structureLevelNames', old: org!.settings.structureLevelNames ?? null, new: clean }] },
    });
    return clean;
  });
}

export async function setProductLevelNames(db: Db, actor: Actor, productId: string, names: string[] | null): Promise<void> {
  const clean = names === null ? null : validateLevelNames(names);
  return withOrg(db, actor.orgId, async (tx) => {
    await requireProductRole(tx, actor, productId, 'admin');
    const [cur] = await tx.select({ names: products.structureLevelNames }).from(products).where(eq(products.id, productId));
    await tx.update(products).set({ structureLevelNames: clean }).where(eq(products.id, productId));
    await recordEvent(tx, {
      orgId: actor.orgId, productId, type: 'product.level_names_set', subjectType: 'product', subjectId: productId, actor,
      payload: { changes: [{ field: 'structureLevelNames', old: cur?.names ?? null, new: clean }] },
    });
  });
}
