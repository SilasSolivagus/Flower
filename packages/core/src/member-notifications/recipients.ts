import { and, eq, inArray, isNull } from 'drizzle-orm';
import { baseProductRole } from '../access/permissions';
import { members, productMembers, products } from '../db/schema';
import type { Tx } from '../db/tx';
import type { OrgRole } from '../domain-types';

export type Recipient = { id: string; displayName: string; email: string | null; orgRole: OrgRole; wecomUserid: string | null };

/**
 * 能收到某产品通知的成员：在职的真人成员，且按组织角色与产品角色能看到该产品（与 productRoleOf 同一口径，不含 Token 范围）。
 * 产品已删除时没有人；productId 为空（组织级，如系统告警）时不看产品。
 */
export async function eligibleMembersTx(tx: Tx, productId: string | null, ids: string[]): Promise<Map<string, Recipient>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  if (productId) {
    const [p] = await tx.select({ id: products.id }).from(products).where(and(eq(products.id, productId), isNull(products.deletedAt)));
    if (!p) return new Map();
  }
  const rows = await tx
    .select({ id: members.id, displayName: members.displayName, email: members.email, orgRole: members.orgRole, wecomUserid: members.wecomUserid })
    .from(members)
    .where(and(inArray(members.id, unique), eq(members.status, 'active'), eq(members.kind, 'human')));
  const roles = productId
    ? await tx
        .select({ memberId: productMembers.memberId, role: productMembers.role })
        .from(productMembers)
        .where(and(eq(productMembers.productId, productId), inArray(productMembers.memberId, unique)))
    : [];
  const roleOf = new Map(roles.map((r) => [r.memberId, r.role]));
  return new Map(rows.filter((m) => !productId || baseProductRole(m.orgRole, roleOf.get(m.id) ?? null) !== null).map((m) => [m.id, m]));
}
