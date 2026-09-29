import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '../src/domain-types';
import { createPlaceholderMember, listMembers } from '../src/tenancy/members';
import { createProduct, listProductMemberRoles, setProductRole } from '../src/tenancy/products';
import { createTestDb } from './db';
import { seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let guestAdmin: Actor;
let viewer: Actor;
let pan: string;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  const g = await createPlaceholderMember(t.db, owner, { displayName: '外部顾问' });
  await setProductRole(t.db, owner, pan, g.id, 'admin');
  guestAdmin = { ...owner, memberId: g.id, orgRole: 'guest', accountId: null };
  const v = await createPlaceholderMember(t.db, owner, { displayName: '只读丙' });
  await setProductRole(t.db, owner, pan, v.id, 'viewer');
  viewer = { ...owner, memberId: v.id, orgRole: 'member', accountId: null };
});
afterAll(() => t.cleanup());

describe('产品成员角色列表', () => {
  it('访客产品管理员不能列组织成员，但能列本产品的成员角色', async () => {
    await expect(listMembers(t.db, guestAdmin)).rejects.toMatchObject({ code: 'forbidden' });
    const rows = await listProductMemberRoles(t.db, guestAdmin, pan);
    expect(rows.map((r) => [r.displayName, r.role])).toEqual([
      ['Owner', null],
      ['外部顾问', 'admin'],
      ['只读丙', 'viewer'],
    ]);
    expect(rows[0]).toMatchObject({ orgRole: 'owner', kind: 'human' });
  });

  it('非产品管理员和只读 Token 不能调用', async () => {
    await expect(listProductMemberRoles(t.db, viewer, pan)).rejects.toMatchObject({ code: 'forbidden' });
    const readToken: Actor = { ...owner, tokenId: '00000000-0000-0000-0000-0000000000f1', tokenScope: { products: 'all', access: 'read' } };
    await expect(listProductMemberRoles(t.db, readToken, pan)).rejects.toMatchObject({ code: 'forbidden' });
  });
});
