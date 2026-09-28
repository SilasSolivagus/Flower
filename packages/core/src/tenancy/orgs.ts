import { and, eq, inArray, isNull } from 'drizzle-orm';
import { requireOrgAdmin, baseProductRole } from '../access/permissions';
import type { AccountView } from '../auth/accounts';
import type { Db } from '../db/client';
import { instanceSettings, members, type OrgSettings, organizations, productMembers, products } from '../db/schema';
import { setOrgContext, type Tx, withOrg, withSystem } from '../db/tx';
import { DEFAULT_LEVEL_NAMES, seedOrgDefaults } from '../definitions/defaults';
import type { Actor, OrgRole, ProductRole } from '../domain-types';
import { AppError, isUniqueViolation } from '../errors';
import { recordEvent } from '../events';
import { newId } from '../ids';

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export type OrgView = { id: string; slug: string; name: string; settings: OrgSettings };

const toOrgView = (o: typeof organizations.$inferSelect): OrgView => ({ id: o.id, slug: o.slug, name: o.name, settings: o.settings });

function assertOrgInput(input: { name: string; slug: string }) {
  const name = input.name.trim();
  if (!name || name.length > 50) throw new AppError('invalid', '组织名称不能为空，且不超过 50 个字符');
  const slug = input.slug.trim();
  if (!SLUG_RE.test(slug)) throw new AppError('invalid', '组织标识只能包含小写字母、数字和连字符，长度 1–40');
  return { name, slug };
}

/** 在已有事务中创建组织（初始化向导复用）。 */
export async function createOrgInTx(
  tx: Tx,
  account: AccountView,
  input: { name: string; slug: string },
): Promise<{ org: OrgView; memberId: string }> {
  const { name, slug } = assertOrgInput(input);
  const orgId = newId();
  await setOrgContext(tx, orgId);
  let org: typeof organizations.$inferSelect;
  try {
    [org] = (await tx
      .insert(organizations)
      .values({ id: orgId, slug, name, settings: { structureLevelNames: DEFAULT_LEVEL_NAMES } })
      .returning()) as [typeof organizations.$inferSelect];
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError('conflict', '该组织标识已被使用');
    throw e;
  }
  const [member] = await tx
    .insert(members)
    .values({ orgId, accountId: account.id, displayName: account.name, email: account.email, orgRole: 'owner' })
    .returning();
  await seedOrgDefaults(tx, orgId, member!.id);
  const actor: Actor = { accountId: account.id, memberId: member!.id, orgId, orgRole: 'owner', tokenId: null, tokenScope: null };
  await recordEvent(tx, { orgId, type: 'organization.created', subjectType: 'organization', subjectId: orgId, actor, payload: { name, slug } });
  return { org: toOrgView(org), memberId: member!.id };
}

export async function createOrganization(
  db: Db,
  account: AccountView,
  input: { name: string; slug: string },
): Promise<{ org: OrgView; memberId: string }> {
  return db.transaction(async (tx) => {
    if (!account.isInstanceAdmin) {
      const [settings] = await tx.select().from(instanceSettings).where(eq(instanceSettings.id, 1));
      if (!settings?.allowOrgCreation) throw new AppError('forbidden', '当前实例不允许用户自行创建组织');
    }
    return createOrgInTx(tx, account, input);
  });
}

export type MyOrg = {
  id: string;
  slug: string;
  name: string;
  role: OrgRole;
  memberId: string;
  products: Array<{ id: string; key: string; name: string; role: ProductRole }>;
};

/** 跨组织查询：列出账号加入的全部组织及其可见产品。 */
export async function listMyOrganizations(db: Db, accountId: string): Promise<MyOrg[]> {
  return withSystem(db, async (tx) => {
    const rows = await tx
      .select({ org: organizations, member: members })
      .from(members)
      .innerJoin(organizations, eq(organizations.id, members.orgId))
      .where(and(eq(members.accountId, accountId), eq(members.status, 'active'), isNull(organizations.deletedAt)))
      .orderBy(organizations.createdAt);
    if (rows.length === 0) return [];
    const orgIds = rows.map((r) => r.org.id);
    const memberIds = rows.map((r) => r.member.id);
    const prods = await tx
      .select()
      .from(products)
      .where(and(inArray(products.orgId, orgIds), isNull(products.deletedAt)))
      .orderBy(products.createdAt);
    const overrides = await tx.select().from(productMembers).where(inArray(productMembers.memberId, memberIds));
    return rows.map(({ org, member }) => ({
      id: org.id,
      slug: org.slug,
      name: org.name,
      role: member.orgRole,
      memberId: member.id,
      products: prods
        .filter((p) => p.orgId === org.id)
        .flatMap((p) => {
          const o = overrides.find((x) => x.productId === p.id && x.memberId === member.id);
          const role = baseProductRole(member.orgRole, o?.role ?? null);
          return role ? [{ id: p.id, key: p.key, name: p.name, role }] : [];
        }),
    }));
  });
}

/** 跨组织查询：按组织标识找到该账号的成员身份。 */
export async function resolveActor(db: Db, accountId: string, orgSlug: string): Promise<Actor | null> {
  return withSystem(db, async (tx) => {
    const [row] = await tx
      .select({ member: members })
      .from(members)
      .innerJoin(organizations, eq(organizations.id, members.orgId))
      .where(
        and(
          eq(organizations.slug, orgSlug),
          isNull(organizations.deletedAt),
          eq(members.accountId, accountId),
          eq(members.status, 'active'),
        ),
      );
    if (!row) return null;
    return {
      accountId,
      memberId: row.member.id,
      orgId: row.member.orgId,
      orgRole: row.member.orgRole,
      tokenId: null,
      tokenScope: null,
    };
  });
}

export async function getOrganization(db: Db, actor: Actor): Promise<OrgView> {
  return withOrg(db, actor.orgId, async (tx) => {
    const [org] = await tx.select().from(organizations).where(eq(organizations.id, actor.orgId));
    if (!org) throw new AppError('not_found', '组织不存在');
    return toOrgView(org);
  });
}

export async function updateOrganization(db: Db, actor: Actor, input: { name?: string; timezone?: string }): Promise<OrgView> {
  requireOrgAdmin(actor);
  return withOrg(db, actor.orgId, async (tx) => {
    const [cur] = await tx.select().from(organizations).where(eq(organizations.id, actor.orgId));
    if (!cur) throw new AppError('not_found', '组织不存在');
    const name = input.name === undefined ? cur.name : assertOrgInput({ name: input.name, slug: cur.slug }).name;
    const settings = input.timezone === undefined ? cur.settings : { ...cur.settings, timezone: input.timezone };
    const [org] = await tx.update(organizations).set({ name, settings }).where(eq(organizations.id, actor.orgId)).returning();
    await recordEvent(tx, {
      orgId: actor.orgId,
      type: 'organization.updated',
      subjectType: 'organization',
      subjectId: actor.orgId,
      actor,
      payload: { changes: [{ field: 'name', old: cur.name, new: name }] },
    });
    return toOrgView(org!);
  });
}
