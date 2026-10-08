import { createAccount, createPlaceholderMember, createRequirement, createProduct, listFunctionTags, listMembers, listRequirements, type Actor } from '@flower/core';
import { createTestDb } from '@flower/core/testing';
import { seedInstance } from '@flower/core/testing/factories';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rejoinAccounts } from '../src/rejoin';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
beforeAll(async () => {
  t = await createTestDb();
  owner = (await seedInstance(t.db)).owner;
});
afterAll(() => t.cleanup());

describe('重导后让已有账号重新加入组织', () => {
  it('发邀请并以该账号接受，恢复组织角色与职能标签；账号或标签不存在时不写入任何数据', async () => {
    await createAccount(t.adminDb, { email: 'design-a@example.com', name: '设计甲', password: 'password123' });
    await createAccount(t.adminDb, { email: 'admin-b@example.com', name: '管理员乙', password: 'password123' });

    await expect(
      rejoinAccounts(t.db, owner, [
        { email: 'design-a@example.com', orgRole: 'member', functionTags: ['设计'] },
        { email: 'nobody@example.com', orgRole: 'member', functionTags: [] },
      ]),
    ).rejects.toThrow('找不到账号 nobody@example.com');
    await expect(rejoinAccounts(t.db, owner, [{ email: 'design-a@example.com', orgRole: 'member', functionTags: ['不存在的标签'] }])).rejects.toThrow(
      '组织里没有职能标签「不存在的标签」',
    );
    expect((await listMembers(t.db, owner)).some((m) => m.email === 'design-a@example.com')).toBe(false);

    const joined = await rejoinAccounts(t.db, owner, [
      { email: 'Design-A@example.com', orgRole: 'member', functionTags: ['设计'] },
      { email: 'admin-b@example.com', orgRole: 'admin', functionTags: [] },
    ]);
    expect(joined.map((j) => j.email)).toEqual(['design-a@example.com', 'admin-b@example.com']);
    expect(joined.every((j) => j.status === 'joined')).toBe(true);
    const design = (await listFunctionTags(t.db, owner)).find((x) => x.name === '设计')!;
    const members = await listMembers(t.db, owner);
    expect(members.find((m) => m.email === 'design-a@example.com')).toMatchObject({ id: joined[0]!.memberId, hasAccount: true, orgRole: 'member', functionTagIds: [design.id] });
    expect(members.find((m) => m.email === 'admin-b@example.com')).toMatchObject({ hasAccount: true, orgRole: 'admin', functionTagIds: [] });
  });

  it('已经是活跃成员的账号跳过，不重复发邀请，也不影响清单里其他账号加入', async () => {
    await createAccount(t.adminDb, { email: 'joined-c@example.com', name: '已在组织丙', password: 'password123' });
    await createAccount(t.adminDb, { email: 'new-d@example.com', name: '新账号丁', password: 'password123' });

    const first = await rejoinAccounts(t.db, owner, [{ email: 'joined-c@example.com', orgRole: 'member', functionTags: [] }]);
    expect(first).toEqual([{ email: 'joined-c@example.com', memberId: first[0]!.memberId, status: 'joined' }]);

    const second = await rejoinAccounts(t.db, owner, [
      { email: 'joined-c@example.com', orgRole: 'admin', functionTags: [] },
      { email: 'new-d@example.com', orgRole: 'member', functionTags: [] },
    ]);
    expect(second).toEqual([
      { email: 'joined-c@example.com', memberId: first[0]!.memberId, status: 'skipped' },
      { email: 'new-d@example.com', memberId: second[1]!.memberId, status: 'joined' },
    ]);
    const members = await listMembers(t.db, owner);
    // 跳过的账号保持原有角色（member），没有被第二次清单里的 admin 覆盖
    expect(members.find((m) => m.email === 'joined-c@example.com')).toMatchObject({ orgRole: 'member' });
    expect(members.find((m) => m.email === 'new-d@example.com')).toMatchObject({ hasAccount: true, orgRole: 'member' });
  });

  it('导入时已有同邮箱、未关联账号的成员：账号绑定到这个成员，保留其名下的历史记录，不另建成员', async () => {
    await createAccount(t.adminDb, { email: 'legacy-e@example.com', name: '旧人戊', password: 'password123' });
    const placeholder = await createPlaceholderMember(t.db, owner, { displayName: '旧人戊', email: 'legacy-e@example.com' });
    const product = await createProduct(t.db, owner, { name: '网盘', key: 'PAN' });
    await createRequirement(t.db, owner, product.id, { title: '旧人戊负责的需求', ownerMemberId: placeholder.id });

    const result = await rejoinAccounts(t.db, owner, [{ email: 'legacy-e@example.com', orgRole: 'member', functionTags: ['开发'] }]);
    expect(result).toEqual([{ email: 'legacy-e@example.com', memberId: placeholder.id, status: 'bound' }]);
    const same = (await listMembers(t.db, owner)).filter((m) => m.email === 'legacy-e@example.com');
    expect(same).toHaveLength(1);
    expect(same[0]).toMatchObject({ id: placeholder.id, hasAccount: true, orgRole: 'member' });
    const list = await listRequirements(t.db, owner, product.id);
    expect(list.items.find((r) => r.title === '旧人戊负责的需求')?.owner?.id).toBe(placeholder.id);

    // 再跑一次：已经关联账号，跳过
    expect(await rejoinAccounts(t.db, owner, [{ email: 'legacy-e@example.com', orgRole: 'member', functionTags: [] }])).toEqual([
      { email: 'legacy-e@example.com', memberId: placeholder.id, status: 'skipped' },
    ]);
  });
});
