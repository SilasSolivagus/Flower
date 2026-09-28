import { randomBytes } from 'node:crypto';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { randomToken, safeEqualHex, sha256 } from '../crypto';
import type { Db } from '../db/client';
import { apiTokens, members, organizations, products } from '../db/schema';
import { withOrg, withSystem } from '../db/tx';
import type { Actor, TokenScope } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import { isOrgAdmin, requireOrgAdmin } from './permissions';

export const tokenScopeSchema = z.object({
  products: z.union([z.literal('all'), z.array(z.string().uuid()).min(1)]),
  access: z.enum(['read', 'write']),
});

export type TokenView = {
  id: string;
  name: string;
  prefix: string;
  memberId: string;
  scope: TokenScope;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
};

const TOKEN_RE = /^flw_([0-9a-f]{10})_[A-Za-z0-9_-]{43}$/;

const view = (r: typeof apiTokens.$inferSelect): TokenView => ({
  id: r.id,
  name: r.name,
  prefix: r.prefix,
  memberId: r.memberId,
  scope: r.scope,
  expiresAt: r.expiresAt,
  lastUsedAt: r.lastUsedAt,
  revokedAt: r.revokedAt,
  createdAt: r.createdAt,
});

export async function issueToken(
  db: Db,
  actor: Actor,
  input: { memberId: string; name: string; scope: TokenScope; expiresAt?: Date | null },
): Promise<{ token: string; record: TokenView }> {
  if (actor.tokenId) throw new AppError('forbidden', '不能用 API Token 签发新的 Token');
  const scope = tokenScopeSchema.safeParse(input.scope);
  if (!scope.success) throw new AppError('invalid', 'Token 范围格式不正确');
  const name = input.name.trim();
  if (!name || name.length > 50) throw new AppError('invalid', 'Token 名称不能为空，且不超过 50 个字符');

  return withOrg(db, actor.orgId, async (tx) => {
    const [target] = await tx.select().from(members).where(eq(members.id, input.memberId));
    if (!target || target.status !== 'active') throw new AppError('not_found', '成员不存在');
    if (target.id !== actor.memberId) {
      if (target.kind !== 'agent') throw new AppError('forbidden', '只能为自己或 Agent 成员签发 Token');
      requireOrgAdmin(actor);
    }
    if (scope.data.products !== 'all') {
      const found = await tx
        .select({ id: products.id })
        .from(products)
        .where(and(inArray(products.id, scope.data.products), isNull(products.deletedAt)));
      if (found.length !== scope.data.products.length) throw new AppError('invalid', 'Token 范围包含不存在的产品');
    }
    const prefix = randomBytes(5).toString('hex');
    const token = `flw_${prefix}_${randomToken(32)}`;
    const [row] = await tx
      .insert(apiTokens)
      .values({
        orgId: actor.orgId,
        memberId: target.id,
        issuedBy: actor.memberId,
        name,
        prefix,
        tokenHash: sha256(token),
        scope: scope.data,
        expiresAt: input.expiresAt ?? null,
      })
      .returning();
    await recordEvent(tx, {
      orgId: actor.orgId,
      type: 'api_token.issued',
      subjectType: 'api_token',
      subjectId: row!.id,
      actor,
      payload: { memberId: target.id, name, scope: scope.data },
    });
    return { token, record: view(row!) };
  });
}

export async function listTokens(db: Db, actor: Actor): Promise<TokenView[]> {
  return withOrg(db, actor.orgId, async (tx) => {
    const rows = await tx
      .select()
      .from(apiTokens)
      .where(isOrgAdmin(actor) ? undefined : eq(apiTokens.memberId, actor.memberId))
      .orderBy(desc(apiTokens.createdAt));
    return rows.map(view);
  });
}

export async function revokeToken(db: Db, actor: Actor, tokenId: string): Promise<void> {
  return withOrg(db, actor.orgId, async (tx) => {
    const [row] = await tx.select().from(apiTokens).where(eq(apiTokens.id, tokenId));
    if (!row) throw new AppError('not_found', 'Token 不存在');
    if (row.memberId !== actor.memberId) requireOrgAdmin(actor);
    await tx.update(apiTokens).set({ revokedAt: new Date() }).where(eq(apiTokens.id, tokenId));
    await recordEvent(tx, { orgId: actor.orgId, type: 'api_token.revoked', subjectType: 'api_token', subjectId: tokenId, actor });
  });
}

/** 跨组织查询：Token 自带组织归属，认证时尚不知道组织。 */
export function authenticateToken(db: Db, raw: string): Promise<{ actor: Actor; orgSlug: string } | null> {
  const m = TOKEN_RE.exec(raw);
  if (!m) return Promise.resolve(null);
  const prefix = m[1]!;
  return withSystem(db, async (tx) => {
    const [row] = await tx
      .select({ token: apiTokens, member: members, org: organizations })
      .from(apiTokens)
      .innerJoin(members, eq(members.id, apiTokens.memberId))
      .innerJoin(organizations, eq(organizations.id, apiTokens.orgId))
      .where(eq(apiTokens.prefix, prefix));
    if (!row) return null;
    const { token, member, org } = row;
    if (!safeEqualHex(token.tokenHash, sha256(raw))) return null;
    if (token.revokedAt || (token.expiresAt && token.expiresAt.getTime() <= Date.now())) return null;
    if (member.status !== 'active' || org.deletedAt) return null;
    await tx.update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.id, token.id));
    return {
      orgSlug: org.slug,
      actor: {
        accountId: member.accountId,
        memberId: member.id,
        orgId: org.id,
        orgRole: member.orgRole,
        tokenId: token.id,
        tokenScope: token.scope,
      },
    };
  });
}
