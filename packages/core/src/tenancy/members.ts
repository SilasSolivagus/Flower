import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import { requireNonGuest, requireOrgAdmin } from '../access/permissions';
import type { Db } from '../db/client';
import { functionTags, memberFunctionTags, members, productMembers } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor, OrgRole, ProductRole } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';

export type MemberView = {
  id: string;
  kind: 'human' | 'agent';
  displayName: string;
  email: string | null;
  department: string | null;
  orgRole: OrgRole;
  status: 'active' | 'left';
  hasAccount: boolean;
  functionTagIds: string[];
  productRoles: Array<{ productId: string; role: ProductRole }>;
};

function assertDisplayName(name: string): string {
  const n = name.trim();
  if (!n || n.length > 50) throw new AppError('invalid', '名称不能为空，且不超过 50 个字符');
  return n;
}

async function loadViews(tx: Tx, ids?: string[]): Promise<MemberView[]> {
  const rows = await tx
    .select()
    .from(members)
    .where(ids ? inArray(members.id, ids) : undefined)
    .orderBy(asc(members.createdAt));
  if (rows.length === 0) return [];
  const memberIds = rows.map((r) => r.id);
  const tags = await tx.select().from(memberFunctionTags).where(inArray(memberFunctionTags.memberId, memberIds));
  const roles = await tx.select().from(productMembers).where(inArray(productMembers.memberId, memberIds));
  return rows.map((m) => ({
    id: m.id,
    kind: m.kind,
    displayName: m.displayName,
    email: m.email,
    department: m.department,
    orgRole: m.orgRole,
    status: m.status,
    hasAccount: m.accountId !== null,
    functionTagIds: tags.filter((x) => x.memberId === m.id).map((x) => x.tagId),
    productRoles: roles.filter((x) => x.memberId === m.id).map((x) => ({ productId: x.productId, role: x.role })),
  }));
}

async function loadOne(tx: Tx, id: string): Promise<MemberView> {
  const [v] = await loadViews(tx, [id]);
  if (!v) throw new AppError('not_found', '成员不存在');
  return v;
}

export async function listMembers(db: Db, actor: Actor): Promise<MemberView[]> {
  requireNonGuest(actor);
  return withOrg(db, actor.orgId, (tx) => loadViews(tx));
}

export async function createPlaceholderMember(
  db: Db,
  actor: Actor,
  input: { displayName: string; email?: string; department?: string },
): Promise<MemberView> {
  requireOrgAdmin(actor);
  const displayName = assertDisplayName(input.displayName);
  return withOrg(db, actor.orgId, async (tx) => {
    const [row] = await tx
      .insert(members)
      .values({
        orgId: actor.orgId,
        displayName,
        email: input.email?.trim().toLowerCase() || null,
        department: input.department?.trim() || null,
        orgRole: 'member',
      })
      .returning();
    await recordEvent(tx, { orgId: actor.orgId, type: 'member.created', subjectType: 'member', subjectId: row!.id, actor, payload: { displayName, hasAccount: false } });
    return loadOne(tx, row!.id);
  });
}

export async function createAgentMember(
  db: Db,
  actor: Actor,
  input: { displayName: string; orgRole?: 'member' | 'guest' },
): Promise<MemberView> {
  requireOrgAdmin(actor);
  const displayName = assertDisplayName(input.displayName);
  return withOrg(db, actor.orgId, async (tx) => {
    const [row] = await tx
      .insert(members)
      .values({ orgId: actor.orgId, kind: 'agent', displayName, orgRole: input.orgRole ?? 'member' })
      .returning();
    await recordEvent(tx, { orgId: actor.orgId, type: 'member.agent_created', subjectType: 'member', subjectId: row!.id, actor, payload: { displayName } });
    return loadOne(tx, row!.id);
  });
}

export async function updateMember(
  db: Db,
  actor: Actor,
  memberId: string,
  input: { displayName?: string; email?: string | null; department?: string | null; orgRole?: OrgRole; status?: 'active' | 'left' },
): Promise<MemberView> {
  requireOrgAdmin(actor);
  return withOrg(db, actor.orgId, async (tx) => {
    const [cur] = await tx.select().from(members).where(eq(members.id, memberId));
    if (!cur) throw new AppError('not_found', '成员不存在');
    const nextRole = input.orgRole ?? cur.orgRole;
    const nextStatus = input.status ?? cur.status;

    if (cur.kind === 'agent' && (nextRole === 'owner' || nextRole === 'admin')) {
      throw new AppError('invalid', 'Agent 成员不能担任组织管理员');
    }
    if ((nextRole === 'owner') !== (cur.orgRole === 'owner') && actor.orgRole !== 'owner') {
      throw new AppError('forbidden', '只有 owner 能授予或撤销 owner');
    }
    if (cur.orgRole === 'owner' && nextStatus !== cur.status && actor.orgRole !== 'owner') {
      throw new AppError('forbidden', '只有 owner 能授予或撤销 owner');
    }
    const losingOwner = cur.orgRole === 'owner' && (nextRole !== 'owner' || nextStatus !== 'active');
    if (losingOwner) {
      const others = await tx
        .select({ id: members.id })
        .from(members)
        .where(and(eq(members.orgRole, 'owner'), eq(members.status, 'active'), ne(members.id, memberId)));
      if (others.length === 0) throw new AppError('invalid', '组织至少需要保留一个 owner');
    }

    const displayName = input.displayName === undefined ? cur.displayName : assertDisplayName(input.displayName);
    const email = input.email === undefined ? cur.email : input.email?.trim().toLowerCase() || null;
    const department = input.department === undefined ? cur.department : input.department?.trim() || null;

    await tx
      .update(members)
      .set({ displayName, email, department, orgRole: nextRole, status: nextStatus })
      .where(eq(members.id, memberId));

    let removedProductRoles: Array<{ productId: string; role: ProductRole }> = [];
    if (nextRole === 'owner' || nextRole === 'admin') {
      const removed = await tx
        .delete(productMembers)
        .where(eq(productMembers.memberId, memberId))
        .returning({ productId: productMembers.productId, role: productMembers.role });
      removedProductRoles = removed;
    }

    await recordEvent(tx, {
      orgId: actor.orgId,
      type: 'member.updated',
      subjectType: 'member',
      subjectId: memberId,
      actor,
      payload: {
        changes: [
          { field: 'displayName', old: cur.displayName, new: displayName },
          { field: 'email', old: cur.email, new: email },
          { field: 'department', old: cur.department, new: department },
          { field: 'orgRole', old: cur.orgRole, new: nextRole },
          { field: 'status', old: cur.status, new: nextStatus },
        ].filter((c) => c.old !== c.new),
        ...(removedProductRoles.length > 0 ? { removedProductRoles } : {}),
      },
    });
    return loadOne(tx, memberId);
  });
}

export async function setMemberFunctionTags(db: Db, actor: Actor, memberId: string, tagIds: string[]): Promise<MemberView> {
  requireOrgAdmin(actor);
  return withOrg(db, actor.orgId, async (tx) => {
    await loadOne(tx, memberId);
    const unique = [...new Set(tagIds)];
    if (unique.length > 0) {
      const found = await tx.select({ id: functionTags.id }).from(functionTags).where(inArray(functionTags.id, unique));
      if (found.length !== unique.length) throw new AppError('invalid', '包含不存在的职能标签');
    }
    await tx.delete(memberFunctionTags).where(eq(memberFunctionTags.memberId, memberId));
    if (unique.length > 0) {
      await tx.insert(memberFunctionTags).values(unique.map((tagId) => ({ orgId: actor.orgId, memberId, tagId })));
    }
    await recordEvent(tx, { orgId: actor.orgId, type: 'member.function_tags_set', subjectType: 'member', subjectId: memberId, actor, payload: { tagIds: unique } });
    return loadOne(tx, memberId);
  });
}
