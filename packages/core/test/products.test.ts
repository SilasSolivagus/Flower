import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { members } from '../src/db/schema';
import type { Actor } from '../src/domain-types';
import { newId } from '../src/ids';
import { createProduct, getProduct, listProductRoles, listProducts, setProductRole, updateProduct } from '../src/tenancy/products';
import { createTestDb } from './db';
import { seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let member: Actor;
let guest: Actor;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  const memberId = newId();
  const guestId = newId();
  await t.adminDb.insert(members).values([
    { id: memberId, orgId: owner.orgId, displayName: '成员', orgRole: 'member' },
    { id: guestId, orgId: owner.orgId, displayName: '访客', orgRole: 'guest' },
  ]);
  member = { ...owner, accountId: null, memberId, orgRole: 'member' };
  guest = { ...owner, accountId: null, memberId: guestId, orgRole: 'guest' };
});
afterAll(() => t.cleanup());

describe('产品', () => {
  it('组织管理员创建产品，默认使用组织的默认流程', async () => {
    const p = await createProduct(t.db, owner, { name: '网盘', key: 'pan' });
    expect(p).toMatchObject({ key: 'PAN', name: '网盘', status: 'active', myRole: 'admin' });
    expect(p.workflowVersionId).toBeTruthy();
  });

  it('前缀重复或格式错误', async () => {
    await expect(createProduct(t.db, owner, { name: '重复', key: 'PAN' })).rejects.toMatchObject({ code: 'conflict' });
    await expect(createProduct(t.db, owner, { name: '坏前缀', key: '1X' })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('普通成员不能创建产品', async () => {
    await expect(createProduct(t.db, member, { name: 'X', key: 'XX' })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('可见性：成员默认可编辑，访客默认看不到，授权后可见', async () => {
    const p = await createProduct(t.db, owner, { name: '会员', key: 'VIP' });
    expect((await listProducts(t.db, member)).map((x) => x.key)).toContain('VIP');
    expect((await getProduct(t.db, member, p.id)).myRole).toBe('editor');
    expect(await listProducts(t.db, guest)).toHaveLength(0);
    await expect(getProduct(t.db, guest, p.id)).rejects.toMatchObject({ code: 'not_found' });

    await setProductRole(t.db, owner, p.id, guest.memberId, 'viewer');
    expect((await getProduct(t.db, guest, p.id)).myRole).toBe('viewer');
    expect(await listProductRoles(t.db, owner, p.id)).toEqual([{ memberId: guest.memberId, role: 'viewer' }]);

    await setProductRole(t.db, owner, p.id, guest.memberId, null);
    await expect(getProduct(t.db, guest, p.id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('不能给组织管理员单独设置产品角色', async () => {
    const p = await createProduct(t.db, owner, { name: '管理', key: 'ADM' });
    await expect(setProductRole(t.db, owner, p.id, owner.memberId, 'viewer')).rejects.toMatchObject({ code: 'invalid' });
  });

  it('产品管理员可以改名和归档，编辑者不行', async () => {
    const p = await createProduct(t.db, owner, { name: '旧', key: 'OLD' });
    const u = await updateProduct(t.db, owner, p.id, { name: '新', status: 'archived' });
    expect(u).toMatchObject({ name: '新', status: 'archived' });
    await expect(updateProduct(t.db, member, p.id, { name: 'x' })).rejects.toMatchObject({ code: 'forbidden' });
  });
});
