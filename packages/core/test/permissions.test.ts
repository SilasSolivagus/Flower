import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  atLeast,
  baseProductRole,
  capByScope,
  isOrgAdmin,
  productRoleOf,
  requireProductRole,
} from '../src/access/permissions';
import { members, organizations, productMembers, products } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import type { Actor } from '../src/domain-types';
import { newId } from '../src/ids';
import { createTestDb } from './db';

describe('纯规则', () => {
  it('组织角色到默认产品角色', () => {
    expect(baseProductRole('owner', 'viewer')).toBe('admin');
    expect(baseProductRole('admin', null)).toBe('admin');
    expect(baseProductRole('member', null)).toBe('editor');
    expect(baseProductRole('member', 'viewer')).toBe('viewer');
    expect(baseProductRole('guest', null)).toBeNull();
    expect(baseProductRole('guest', 'editor')).toBe('editor');
  });

  it('Token 范围收窄权限', () => {
    expect(capByScope('admin', null, 'p1')).toBe('admin');
    expect(capByScope('admin', { products: 'all', access: 'read' }, 'p1')).toBe('viewer');
    expect(capByScope('editor', { products: ['p2'], access: 'write' }, 'p1')).toBeNull();
    expect(capByScope('editor', { products: ['p1'], access: 'write' }, 'p1')).toBe('editor');
    expect(capByScope(null, { products: 'all', access: 'write' }, 'p1')).toBeNull();
  });

  it('角色高低比较', () => {
    expect(atLeast('admin', 'editor')).toBe(true);
    expect(atLeast('viewer', 'editor')).toBe(false);
    expect(atLeast(null, 'viewer')).toBe(false);
  });

  it('组织管理员判断受 Token 范围约束', () => {
    const base: Actor = { accountId: 'a', memberId: 'm', orgId: 'o', orgRole: 'admin', tokenId: null, tokenScope: null };
    expect(isOrgAdmin(base)).toBe(true);
    expect(isOrgAdmin({ ...base, orgRole: 'member' })).toBe(false);
    expect(isOrgAdmin({ ...base, tokenId: 't', tokenScope: { products: 'all', access: 'read' } })).toBe(false);
    expect(isOrgAdmin({ ...base, tokenId: 't', tokenScope: { products: ['p'], access: 'write' } })).toBe(false);
    expect(isOrgAdmin({ ...base, tokenId: 't', tokenScope: { products: 'all', access: 'write' } })).toBe(true);
  });
});

describe('productRoleOf（读库）', () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  const orgId = newId();
  const productId = newId();
  const guestId = newId();
  const memberId = newId();

  beforeAll(async () => {
    t = await createTestDb();
    await t.adminDb.insert(organizations).values({ id: orgId, slug: 'perm', name: '权限' });
    await t.adminDb.insert(products).values({ id: productId, orgId, key: 'PP', name: 'P' });
    await t.adminDb.insert(members).values([
      { id: guestId, orgId, displayName: '访客', orgRole: 'guest' },
      { id: memberId, orgId, displayName: '成员', orgRole: 'member' },
    ]);
    await t.adminDb.insert(productMembers).values({ orgId, productId, memberId, role: 'viewer' });
  });
  afterAll(() => t.cleanup());

  const actor = (id: string, orgRole: Actor['orgRole']): Actor => ({
    accountId: null, memberId: id, orgId, orgRole, tokenId: null, tokenScope: null,
  });

  it('按产品覆盖计算角色', async () => {
    expect(await withOrg(t.db, orgId, (tx) => productRoleOf(tx, actor(memberId, 'member'), productId))).toBe('viewer');
    expect(await withOrg(t.db, orgId, (tx) => productRoleOf(tx, actor(guestId, 'guest'), productId))).toBeNull();
  });

  it('看不到的产品返回 not_found，权限不够返回 forbidden', async () => {
    await expect(
      withOrg(t.db, orgId, (tx) => requireProductRole(tx, actor(guestId, 'guest'), productId, 'viewer')),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      withOrg(t.db, orgId, (tx) => requireProductRole(tx, actor(memberId, 'member'), productId, 'editor')),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('不存在的产品返回 not_found', async () => {
    await expect(
      withOrg(t.db, orgId, (tx) => requireProductRole(tx, actor(memberId, 'owner'), newId(), 'viewer')),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
