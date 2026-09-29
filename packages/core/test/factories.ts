import type { AccountView } from '../src/auth/accounts';
import type { Db } from '../src/db/client';
import type { Actor } from '../src/domain-types';
import { initializeInstance } from '../src/setup/instance';
import { type OrgView, resolveActor } from '../src/tenancy/orgs';
import { createPlaceholderMember } from '../src/tenancy/members';

export const OWNER_EMAIL = 'owner@example.com';
export const OWNER_PASSWORD = 'password123';

/** 初始化实例，返回实例管理员账号、组织 acme 及其 owner 操作者。 */
export async function seedInstance(db: Db): Promise<{ account: AccountView; org: OrgView; owner: Actor }> {
  const { account, org } = await initializeInstance(db, {
    admin: { email: OWNER_EMAIL, name: 'Owner', password: OWNER_PASSWORD },
    org: { name: '测试组织', slug: 'acme' },
  });
  const owner = await resolveActor(db, account.id, 'acme');
  if (!owner) throw new Error('seedInstance: 无法解析 owner');
  return { account, org, owner };
}

/** 新建一个占位成员，返回以该成员身份操作的 Actor（沿用 owner 的组织信息，替换 memberId 与组织角色）。 */
export async function asMember(db: Db, owner: Actor, displayName: string, orgRole: Actor['orgRole'] = 'member'): Promise<Actor> {
  const m = await createPlaceholderMember(db, owner, { displayName });
  return { ...owner, memberId: m.id, orgRole, accountId: null };
}
