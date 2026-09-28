import { and, eq, isNull } from 'drizzle-orm';
import { productMembers, products } from '../db/schema';
import type { Tx } from '../db/tx';
import type { Actor, OrgRole, ProductRole, TokenScope } from '../domain-types';
import { AppError } from '../errors';

const RANK: Record<ProductRole, number> = { viewer: 1, editor: 2, admin: 3 };

export function baseProductRole(orgRole: OrgRole, override: ProductRole | null): ProductRole | null {
  if (orgRole === 'owner' || orgRole === 'admin') return 'admin';
  if (orgRole === 'member') return override ?? 'editor';
  return override;
}

export function capByScope(role: ProductRole | null, scope: TokenScope | null, productId: string): ProductRole | null {
  if (!role || !scope) return role;
  if (scope.products !== 'all' && !scope.products.includes(productId)) return null;
  return scope.access === 'read' ? 'viewer' : role;
}

export function atLeast(role: ProductRole | null, need: ProductRole): boolean {
  return role !== null && RANK[role] >= RANK[need];
}

export async function productRoleOf(tx: Tx, actor: Actor, productId: string): Promise<ProductRole | null> {
  const [product] = await tx
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.id, productId), isNull(products.deletedAt)));
  if (!product) return null;
  const [row] = await tx
    .select({ role: productMembers.role })
    .from(productMembers)
    .where(and(eq(productMembers.productId, productId), eq(productMembers.memberId, actor.memberId)));
  return capByScope(baseProductRole(actor.orgRole, row?.role ?? null), actor.tokenScope, productId);
}

export async function requireProductRole(tx: Tx, actor: Actor, productId: string, need: ProductRole): Promise<ProductRole> {
  const role = await productRoleOf(tx, actor, productId);
  if (!role) throw new AppError('not_found', '产品不存在');
  if (!atLeast(role, need)) throw new AppError('forbidden', '权限不足');
  return role;
}

export function isOrgAdmin(actor: Actor): boolean {
  if (actor.orgRole !== 'owner' && actor.orgRole !== 'admin') return false;
  if (!actor.tokenScope) return true;
  return actor.tokenScope.access === 'write' && actor.tokenScope.products === 'all';
}

export function requireOrgAdmin(actor: Actor): void {
  if (!isOrgAdmin(actor)) throw new AppError('forbidden', '需要组织管理员权限');
}

export function requireNonGuest(actor: Actor): void {
  if (actor.orgRole === 'guest') throw new AppError('forbidden', '访客无权查看此内容');
}
