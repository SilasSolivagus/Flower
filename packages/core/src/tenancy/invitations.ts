import { and, desc, eq, isNull } from 'drizzle-orm';
import { requireOrgAdmin } from '../access/permissions';
import { createAccount, normalizeEmail } from '../auth/accounts';
import { randomToken, sha256 } from '../crypto';
import type { Db } from '../db/client';
import { accounts, invitations, members, organizations } from '../db/schema';
import { setOrgContext, withOrg, withSystem } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';

export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type InvitationView = {
  id: string;
  email: string;
  orgRole: 'admin' | 'member' | 'guest';
  memberId: string | null;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
};

const view = (r: typeof invitations.$inferSelect): InvitationView => ({
  id: r.id,
  email: r.email,
  orgRole: r.orgRole,
  memberId: r.memberId,
  expiresAt: r.expiresAt,
  acceptedAt: r.acceptedAt,
  revokedAt: r.revokedAt,
  createdAt: r.createdAt,
});

function statusOf(r: typeof invitations.$inferSelect): 'pending' | 'expired' | 'accepted' | 'revoked' {
  if (r.acceptedAt) return 'accepted';
  if (r.revokedAt) return 'revoked';
  if (r.expiresAt.getTime() <= Date.now()) return 'expired';
  return 'pending';
}

export async function createInvitation(
  db: Db,
  actor: Actor,
  input: { email: string; orgRole: 'admin' | 'member' | 'guest'; memberId?: string },
): Promise<{ invitation: InvitationView; token: string }> {
  requireOrgAdmin(actor);
  const email = normalizeEmail(input.email);
  if (!EMAIL_RE.test(email)) throw new AppError('invalid', '邮箱格式不正确');
  return withOrg(db, actor.orgId, async (tx) => {
    const [already] = await tx
      .select({ id: members.id })
      .from(members)
      .innerJoin(accounts, eq(accounts.id, members.accountId))
      .where(and(eq(accounts.email, email), eq(members.status, 'active')));
    if (already) throw new AppError('conflict', '该邮箱已是组织成员');
    if (input.memberId) {
      const [m] = await tx.select().from(members).where(eq(members.id, input.memberId));
      if (!m) throw new AppError('not_found', '成员不存在');
      if (m.kind !== 'human' || m.accountId) throw new AppError('invalid', '只能绑定没有账号的成员');
    }
    const token = randomToken();
    const [row] = await tx
      .insert(invitations)
      .values({
        orgId: actor.orgId,
        email,
        orgRole: input.orgRole,
        memberId: input.memberId ?? null,
        tokenHash: sha256(token),
        expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
        invitedBy: actor.memberId,
      })
      .returning();
    await recordEvent(tx, { orgId: actor.orgId, type: 'invitation.created', subjectType: 'invitation', subjectId: row!.id, actor, payload: { email, orgRole: input.orgRole } });
    return { invitation: view(row!), token };
  });
}

export async function listInvitations(db: Db, actor: Actor): Promise<InvitationView[]> {
  requireOrgAdmin(actor);
  return withOrg(db, actor.orgId, async (tx) =>
    (await tx.select().from(invitations).orderBy(desc(invitations.createdAt))).map(view),
  );
}

export async function revokeInvitation(db: Db, actor: Actor, invitationId: string): Promise<void> {
  requireOrgAdmin(actor);
  return withOrg(db, actor.orgId, async (tx) => {
    const [row] = await tx
      .update(invitations)
      .set({ revokedAt: new Date() })
      .where(and(eq(invitations.id, invitationId), isNull(invitations.acceptedAt)))
      .returning();
    if (!row) throw new AppError('not_found', '邀请不存在或已被接受');
    await recordEvent(tx, { orgId: actor.orgId, type: 'invitation.revoked', subjectType: 'invitation', subjectId: invitationId, actor });
  });
}

export type InvitationPreview = {
  orgName: string;
  orgSlug: string;
  email: string;
  status: 'pending' | 'expired' | 'accepted' | 'revoked';
  accountExists: boolean;
};

/** 跨组织查询：未登录用户凭邀请链接查看邀请。 */
export function previewInvitation(db: Db, token: string): Promise<InvitationPreview | null> {
  return withSystem(db, async (tx) => {
    const [row] = await tx
      .select({ inv: invitations, org: organizations })
      .from(invitations)
      .innerJoin(organizations, eq(organizations.id, invitations.orgId))
      .where(eq(invitations.tokenHash, sha256(token)));
    if (!row) return null;
    const [acc] = await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.email, row.inv.email));
    return {
      orgName: row.org.name,
      orgSlug: row.org.slug,
      email: row.inv.email,
      status: statusOf(row.inv),
      accountExists: Boolean(acc),
    };
  });
}

/** 跨组织查询：接受邀请时组织尚未确定，先在系统范围内定位邀请，再切换到该组织上下文写入。 */
export function acceptInvitation(
  db: Db,
  token: string,
  who: { accountId: string } | { newAccount: { name: string; password: string } },
): Promise<{ accountId: string; orgSlug: string; memberId: string }> {
  return withSystem(db, async (tx) => {
    const [row] = await tx
      .select({ inv: invitations, org: organizations })
      .from(invitations)
      .innerJoin(organizations, eq(organizations.id, invitations.orgId))
      .where(eq(invitations.tokenHash, sha256(token)));
    if (!row) throw new AppError('not_found', '邀请不存在');
    const { inv, org } = row;
    const status = statusOf(inv);
    if (status !== 'pending') {
      throw new AppError('invalid', { accepted: '邀请已被接受', revoked: '邀请已被撤销', expired: '邀请已过期' }[status]);
    }

    let accountId: string;
    let accountName: string;
    if ('accountId' in who) {
      const [acc] = await tx.select().from(accounts).where(eq(accounts.id, who.accountId));
      if (!acc) throw new AppError('not_found', '账号不存在');
      if (acc.email !== inv.email) throw new AppError('forbidden', '该邀请发给了另一个邮箱');
      accountId = acc.id;
      accountName = acc.name;
    } else {
      const [exists] = await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.email, inv.email));
      if (exists) throw new AppError('conflict', '该邮箱已注册，请先登录再接受邀请');
      const acc = await createAccount(tx, { email: inv.email, ...who.newAccount });
      accountId = acc.id;
      accountName = acc.name;
    }

    await setOrgContext(tx, inv.orgId);
    const [dup] = await tx
      .select({ id: members.id })
      .from(members)
      .where(and(eq(members.orgId, inv.orgId), eq(members.accountId, accountId)));
    if (dup) throw new AppError('conflict', '你已经是该组织的成员');

    let memberId: string;
    if (inv.memberId) {
      await tx.update(members).set({ accountId, orgRole: inv.orgRole, email: inv.email }).where(eq(members.id, inv.memberId));
      memberId = inv.memberId;
    } else {
      const [m] = await tx
        .insert(members)
        .values({ orgId: inv.orgId, accountId, displayName: accountName, email: inv.email, orgRole: inv.orgRole })
        .returning();
      memberId = m!.id;
    }
    await tx.update(invitations).set({ acceptedAt: new Date() }).where(eq(invitations.id, inv.id));
    const actor: Actor = { accountId, memberId, orgId: inv.orgId, orgRole: inv.orgRole, tokenId: null, tokenScope: null };
    await recordEvent(tx, { orgId: inv.orgId, type: 'member.joined', subjectType: 'member', subjectId: memberId, actor, payload: { invitationId: inv.id } });
    return { accountId, orgSlug: org.slug, memberId };
  });
}
