import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { domainEvents } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import type { Actor } from '../src/domain-types';
import { createFunctionTag, deleteFunctionTag, listFunctionTags, updateFunctionTag } from '../src/tenancy/function-tags';
import { authenticateToken, issueToken } from '../src/access/tokens';
import { createAgentMember, createPlaceholderMember, listMembers, setMemberFunctionTags, updateMember } from '../src/tenancy/members';
import { createProduct, setProductRole } from '../src/tenancy/products';
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

  it('只有 owner 能通过状态变更撤销 owner', async () => {
    const other = await createPlaceholderMember(t.db, owner, { displayName: '王五' });
    const promoted = await updateMember(t.db, owner, other.id, { orgRole: 'owner' });
    expect(promoted.orgRole).toBe('owner');
    const adminActor: Actor = { ...owner, memberId: promoted.id, orgRole: 'admin' };
    await expect(updateMember(t.db, adminActor, promoted.id, { status: 'left' })).rejects.toMatchObject({ code: 'forbidden' });
    const deactivated = await updateMember(t.db, owner, promoted.id, { status: 'left' });
    expect(deactivated).toMatchObject({ status: 'left' });
  });

  it('普通成员不能登记成员', async () => {
    await expect(createPlaceholderMember(t.db, { ...owner, orgRole: 'member' }, { displayName: 'x' })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('访客不能查看成员列表', async () => {
    await expect(listMembers(t.db, { ...owner, orgRole: 'guest' })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('修改资料写入准确的 changes，晋升为 admin 时记录被移除的产品角色覆盖', async () => {
    const m = await createPlaceholderMember(t.db, owner, { displayName: '赵六', email: 'zhao@example.com', department: '产品部' });
    const p = await createProduct(t.db, owner, { name: '待授权产品', key: 'GRT' });
    await setProductRole(t.db, owner, p.id, m.id, 'viewer');

    await updateMember(t.db, owner, m.id, { displayName: '赵六六', email: 'zhao6@example.com' });
    const [renameEvent] = await withOrg(t.db, owner.orgId, (tx) =>
      tx.select().from(domainEvents).where(and(eq(domainEvents.subjectId, m.id), eq(domainEvents.type, 'member.updated'))).orderBy(desc(domainEvents.occurredAt)).limit(1),
    );
    expect(renameEvent?.payload).toMatchObject({
      changes: [
        { field: 'displayName', old: '赵六', new: '赵六六' },
        { field: 'email', old: 'zhao@example.com', new: 'zhao6@example.com' },
      ],
    });
    expect((renameEvent?.payload as Record<string, unknown>).removedProductRoles).toBeUndefined();

    await updateMember(t.db, owner, m.id, { orgRole: 'admin' });
    const [promoteEvent] = await withOrg(t.db, owner.orgId, (tx) =>
      tx.select().from(domainEvents).where(and(eq(domainEvents.subjectId, m.id), eq(domainEvents.type, 'member.updated'))).orderBy(desc(domainEvents.occurredAt)).limit(1),
    );
    expect(promoteEvent?.payload).toMatchObject({
      changes: [{ field: 'orgRole', old: 'member', new: 'admin' }],
      removedProductRoles: [{ productId: p.id, role: 'viewer' }],
    });
  });

  it('成员离开时清掉产品角色并吊销 Token，重新启用后不恢复', async () => {
    const product = await createProduct(t.db, owner, { name: '离开测试', key: 'LVE' });
    const agent = await createAgentMember(t.db, owner, { displayName: '离开的助手' });
    await setProductRole(t.db, owner, product.id, agent.id, 'viewer');
    const { token } = await issueToken(t.db, owner, { memberId: agent.id, name: 't', scope: { products: 'all', access: 'read' } });
    expect(await authenticateToken(t.db, token)).not.toBeNull();

    const left = await updateMember(t.db, owner, agent.id, { status: 'left' });
    expect(left.productRoles).toEqual([]);
    expect(await authenticateToken(t.db, token)).toBeNull();

    const back = await updateMember(t.db, owner, agent.id, { status: 'active' });
    expect(back.productRoles).toEqual([]);
    expect(await authenticateToken(t.db, token)).toBeNull();
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
