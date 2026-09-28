import type { AccountView } from '../src/auth/accounts';
import type { Db } from '../src/db/client';
import type { Actor } from '../src/domain-types';
import { initializeInstance } from '../src/setup/instance';
import { type OrgView, resolveActor } from '../src/tenancy/orgs';

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
