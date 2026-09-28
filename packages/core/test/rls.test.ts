import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { domainEvents, organizations, products } from '../src/db/schema';
import { withOrg, withSystem } from '../src/db/tx';
import { newId } from '../src/ids';
import { createTestDb } from './db';

let t: Awaited<ReturnType<typeof createTestDb>>;
const orgA = newId();
const orgB = newId();

beforeAll(async () => {
  t = await createTestDb();
  await t.adminDb.insert(organizations).values([
    { id: orgA, slug: 'a', name: 'A' },
    { id: orgB, slug: 'b', name: 'B' },
  ]);
  await t.adminDb.insert(products).values([
    { orgId: orgA, key: 'AA', name: 'A 产品' },
    { orgId: orgB, key: 'BB', name: 'B 产品' },
  ]);
});
afterAll(() => t.cleanup());

describe('行级安全', () => {
  it('运行时角色不是超级用户', async () => {
    const rows = await t.db.execute(sql`select rolsuper from pg_roles where rolname = current_user`);
    expect(rows[0]).toMatchObject({ rolsuper: false });
  });

  it('未设置组织上下文时看不到任何租户数据', async () => {
    expect(await t.db.select().from(products)).toHaveLength(0);
    expect(await t.db.select().from(organizations)).toHaveLength(0);
  });

  it('withOrg 只能看到本组织的数据', async () => {
    const rows = await withOrg(t.db, orgA, (tx) => tx.select().from(products));
    expect(rows.map((r) => r.key)).toEqual(['AA']);
    const orgs = await withOrg(t.db, orgA, (tx) => tx.select().from(organizations));
    expect(orgs.map((o) => o.slug)).toEqual(['a']);
  });

  it('withOrg 不能写入其他组织的数据', async () => {
    await expect(
      withOrg(t.db, orgA, (tx) => tx.insert(products).values({ orgId: orgB, key: 'XX', name: '越权' })),
    ).rejects.toThrow();
  });

  it('withOrg 不能改到其他组织的数据', async () => {
    const updated = await withOrg(t.db, orgA, (tx) =>
      tx.update(products).set({ name: '被改了' }).where(eq(products.key, 'BB')).returning(),
    );
    expect(updated).toHaveLength(0);
  });

  it('上下文不会泄漏到同一连接的下一个事务', async () => {
    await withOrg(t.db, orgA, (tx) => tx.select().from(products));
    expect(await t.db.select().from(products)).toHaveLength(0);
  });

  it('withSystem 可以跨组织读取', async () => {
    const rows = await withSystem(t.db, (tx) => tx.select().from(products));
    expect(rows).toHaveLength(2);
  });

  it('运行时角色不能修改或删除 domain_events（只能追加）', async () => {
    const eventId = newId();
    await t.adminDb.insert(domainEvents).values({
      id: eventId, orgId: orgA, type: 'test.happened', subjectType: 'test', subjectId: newId(), payload: {},
    });
    await expect(
      withOrg(t.db, orgA, (tx) => tx.update(domainEvents).set({ type: 'tampered' }).where(eq(domainEvents.id, eventId))),
    ).rejects.toThrow();
    await expect(
      withOrg(t.db, orgA, (tx) => tx.delete(domainEvents).where(eq(domainEvents.id, eventId))),
    ).rejects.toThrow();
  });
});
