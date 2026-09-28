import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '../src/domain-types';
import { createFunctionTag, deleteFunctionTag, listFunctionTags, updateFunctionTag } from '../src/tenancy/function-tags';
import { createAgentMember, createPlaceholderMember, listMembers, setMemberFunctionTags, updateMember } from '../src/tenancy/members';
import { createTestDb } from './db';
import { seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
});
afterAll(() => t.cleanup());

describe('成员', () => {
  it('登记无账号成员，列表中标明没有账号', async () => {
    const m = await createPlaceholderMember(t.db, owner, { displayName: '王总', department: '商务部' });
    expect(m).toMatchObject({ kind: 'human', hasAccount: false, orgRole: 'member', department: '商务部' });
    const list = await listMembers(t.db, owner);
    expect(list.map((x) => x.displayName)).toEqual(expect.arrayContaining(['Owner', '王总']));
    expect(list.find((x) => x.displayName === 'Owner')?.hasAccount).toBe(true);
  });

  it('创建 Agent 成员，不能设为管理员', async () => {
    const a = await createAgentMember(t.db, owner, { displayName: 'PRD 助手' });
    expect(a).toMatchObject({ kind: 'agent', orgRole: 'member', hasAccount: false });
    await expect(updateMember(t.db, owner, a.id, { orgRole: 'admin' })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('只有 owner 能授予或撤销 owner；不能移除最后一个 owner', async () => {
    const m = await createPlaceholderMember(t.db, owner, { displayName: '李四' });
    const adminActor: Actor = { ...owner, memberId: m.id, orgRole: 'admin' };
    await expect(updateMember(t.db, adminActor, m.id, { orgRole: 'owner' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(updateMember(t.db, owner, owner.memberId, { orgRole: 'admin' })).rejects.toMatchObject({ code: 'invalid' });
    const promoted = await updateMember(t.db, owner, m.id, { orgRole: 'admin', department: '研发部' });
    expect(promoted).toMatchObject({ orgRole: 'admin', department: '研发部' });
  });

  it('普通成员不能登记成员', async () => {
    await expect(createPlaceholderMember(t.db, { ...owner, orgRole: 'member' }, { displayName: 'x' })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('访客不能查看成员列表', async () => {
    await expect(listMembers(t.db, { ...owner, orgRole: 'guest' })).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('职能标签', () => {
  it('默认有四个标签，可以增改删，并分配给成员', async () => {
    expect((await listFunctionTags(t.db, owner)).map((x) => x.name)).toEqual(['产品经理', '设计', '开发', '测试']);
    const tag = await createFunctionTag(t.db, owner, { name: '线条负责人', color: '#be123c' });
    await expect(createFunctionTag(t.db, owner, { name: '线条负责人', color: '#be123c' })).rejects.toMatchObject({ code: 'conflict' });
    const renamed = await updateFunctionTag(t.db, owner, tag.id, { name: '业务线负责人' });
    expect(renamed.name).toBe('业务线负责人');

    const m = await createPlaceholderMember(t.db, owner, { displayName: '赵六' });
    const withTag = await setMemberFunctionTags(t.db, owner, m.id, [tag.id]);
    expect(withTag.functionTagIds).toEqual([tag.id]);

    await deleteFunctionTag(t.db, owner, tag.id);
    const after = (await listMembers(t.db, owner)).find((x) => x.id === m.id);
    expect(after?.functionTagIds).toEqual([]);
  });

  it('颜色格式错误', async () => {
    await expect(createFunctionTag(t.db, owner, { name: 'X', color: 'red' })).rejects.toMatchObject({ code: 'invalid' });
  });
});
