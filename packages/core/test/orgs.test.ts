import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAccount } from '../src/auth/accounts';
import { domainEvents, fieldDefinitions, fieldOptions, functionTags, instanceSettings, workflowDefinitions } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import { createOrganization, listMyOrganizations, resolveActor, updateOrganization } from '../src/tenancy/orgs';
import { createTestDb } from './db';

let t: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  t = await createTestDb();
  await t.adminDb.insert(instanceSettings).values({ id: 1 });
});
afterAll(() => t.cleanup());

describe('组织', () => {
  it('实例管理员可以创建组织，自动成为 owner 并获得默认配置', async () => {
    const admin = await createAccount(t.db, { email: 'root@example.com', name: 'Root', password: 'password123', isInstanceAdmin: true });
    const { org, memberId } = await createOrganization(t.db, admin, { name: '123云盘', slug: 'pan' });
    expect(org.slug).toBe('pan');
    expect(org.settings.structureLevelNames).toEqual(['业务域', '模块', '功能点']);

    const actor = await resolveActor(t.db, admin.id, 'pan');
    expect(actor).toMatchObject({ memberId, orgId: org.id, orgRole: 'owner', tokenId: null });

    const defs = await withOrg(t.db, org.id, (tx) => tx.select().from(workflowDefinitions));
    expect(defs).toHaveLength(1);
    expect(defs[0]?.currentVersionId).toBeTruthy();
    const fields = await withOrg(t.db, org.id, (tx) => tx.select().from(fieldDefinitions));
    expect(fields.map((f) => f.key).sort()).toEqual(['line', 'platform', 'priority', 'source']);
    const opts = await withOrg(t.db, org.id, (tx) => tx.select().from(fieldOptions));
    expect(opts.sort((a, b) => a.sort - b.sort).map((o) => o.label)).toEqual(['P0', 'P1', 'P2', 'P3']);
    const tags = await withOrg(t.db, org.id, (tx) => tx.select().from(functionTags));
    expect(tags.sort((a, b) => a.sort - b.sort).map((x) => x.name)).toEqual(['产品经理', '设计', '开发', '测试']);
  });

  it('slug 重复与格式错误', async () => {
    const admin = await createAccount(t.db, { email: 'root2@example.com', name: 'Root2', password: 'password123', isInstanceAdmin: true });
    await expect(createOrganization(t.db, admin, { name: 'X', slug: 'pan' })).rejects.toMatchObject({ code: 'conflict' });
    await expect(createOrganization(t.db, admin, { name: 'X', slug: 'Bad Slug' })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('实例未开放建组织时，普通账号不能创建', async () => {
    const user = await createAccount(t.db, { email: 'user@example.com', name: 'User', password: 'password123' });
    await expect(createOrganization(t.db, user, { name: 'Y', slug: 'y' })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('列出我加入的组织；非成员解析不到操作者', async () => {
    const admin = await createAccount(t.db, { email: 'multi@example.com', name: 'Multi', password: 'password123', isInstanceAdmin: true });
    await createOrganization(t.db, admin, { name: '甲', slug: 'jia' });
    await createOrganization(t.db, admin, { name: '乙', slug: 'yi' });
    const mine = await listMyOrganizations(t.db, admin.id);
    expect(mine.map((o) => o.slug).sort()).toEqual(['jia', 'yi']);
    expect(mine[0]?.role).toBe('owner');
    expect(await resolveActor(t.db, admin.id, 'pan')).toBeNull();
    expect(await resolveActor(t.db, admin.id, 'no-such-org')).toBeNull();
  });

  it('管理员修改组织名称与时区，并写入事件', async () => {
    const admin = await createAccount(t.db, { email: 'upd@example.com', name: 'Upd', password: 'password123', isInstanceAdmin: true });
    await createOrganization(t.db, admin, { name: '旧名', slug: 'upd' });
    const actor = (await resolveActor(t.db, admin.id, 'upd'))!;
    const org = await updateOrganization(t.db, actor, { name: '新名', timezone: 'Asia/Shanghai' });
    expect(org).toMatchObject({ name: '新名', settings: { timezone: 'Asia/Shanghai' } });
    await expect(updateOrganization(t.db, { ...actor, orgRole: 'member' }, { name: 'x' })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('只改时区时，事件里只记录时区的变化', async () => {
    const admin = await createAccount(t.db, { email: 'tz@example.com', name: 'Tz', password: 'password123', isInstanceAdmin: true });
    await createOrganization(t.db, admin, { name: '时区组织', slug: 'tz-org' });
    const actor = (await resolveActor(t.db, admin.id, 'tz-org'))!;
    await updateOrganization(t.db, actor, { timezone: 'Asia/Tokyo' });
    const [event] = await withOrg(t.db, actor.orgId, (tx) =>
      tx.select().from(domainEvents).where(and(eq(domainEvents.orgId, actor.orgId), eq(domainEvents.type, 'organization.updated'))).orderBy(desc(domainEvents.occurredAt)),
    );
    expect(event?.payload).toMatchObject({ changes: [{ field: 'timezone', old: null, new: 'Asia/Tokyo' }] });
  });
});
