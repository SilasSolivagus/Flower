import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, runMigrations } from '../src/db/migrate';
import { entityLinks, iterations, organizations, products, tasks } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import { newId } from '../src/ids';
import { ADMIN_URL, APP_PASSWORD, createTestDb, urlFor } from './db';

let t: Awaited<ReturnType<typeof createTestDb>>;
const orgA = newId();
const orgB = newId();
const productA = newId();

beforeAll(async () => {
  t = await createTestDb();
  await t.adminDb.insert(organizations).values([
    { id: orgA, slug: 'a', name: 'A' },
    { id: orgB, slug: 'b', name: 'B' },
  ]);
  await t.adminDb.insert(products).values({ id: productA, orgId: orgA, key: 'AA', name: 'A 产品' });
});
afterAll(() => t.cleanup());

describe('P2-B1 数据模型', () => {
  it('entity_links 受行级安全约束；悬空链接的目标为空；默认来源为 wikilink', async () => {
    await withOrg(t.db, orgA, (tx) =>
      tx.insert(entityLinks).values({ orgId: orgA, sourceType: 'requirement', sourceId: newId(), targetType: 'requirement', targetId: null, targetText: 'AA-9', context: '见 [[AA-9]]' }),
    );
    const mine = await withOrg(t.db, orgA, (tx) => tx.select().from(entityLinks));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ origin: 'wikilink', sourceSection: null, targetSection: null, targetId: null });
    expect(await withOrg(t.db, orgB, (tx) => tx.select().from(entityLinks))).toHaveLength(0);
    const [{ n }] = (await t.adminDb.execute(sql`select count(*)::int as n from pg_policies where tablename = 'entity_links'`)) as unknown as [{ n: number }];
    expect(n).toBe(1);
  });

  it('任务编号在同一产品内唯一；task_seq 默认为 0', async () => {
    await t.adminDb.insert(tasks).values({ orgId: orgA, productId: productA, number: 1, title: '甲' });
    await expect(t.adminDb.insert(tasks).values({ orgId: orgA, productId: productA, number: 1, title: '乙' })).rejects.toThrow();
    const [p] = await t.adminDb.select({ seq: products.taskSeq }).from(products).where(eq(products.id, productA));
    expect(p!.seq).toBe(0);
  });

  it('同一产品内未删除的迭代不能重名；删除后可以再用这个名字；专项不受约束', async () => {
    const base = { orgId: orgA, productId: productA, type: 'regular' as const, name: '0316', startDate: '2026-03-02', endDate: '2026-03-13' };
    const [first] = await t.adminDb.insert(iterations).values(base).returning();
    await expect(t.adminDb.insert(iterations).values({ ...base, startDate: '2026-04-01', endDate: '2026-04-10' })).rejects.toThrow();
    await t.adminDb.update(iterations).set({ deletedAt: new Date() }).where(eq(iterations.id, first!.id));
    await t.adminDb.insert(iterations).values({ ...base, startDate: '2026-04-01', endDate: '2026-04-10' });
    const special = { orgId: orgA, productId: null, type: 'special' as const, name: '专项', startDate: '2026-03-02', endDate: '2026-03-13' };
    await t.adminDb.insert(iterations).values([special, special]);
  });

  it('补号迁移：同一产品内按创建时间（相同时按 id）为已有任务编号，task_seq 设为最大值', async () => {
    const name = `flower_t_mig_${Date.now().toString(36)}`;
    const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE ${name}`);
    const dir = mkdtempSync(path.join(os.tmpdir(), 'flower-mig-'));
    cpSync(MIGRATIONS_DIR, dir, { recursive: true });
    const journalPath = path.join(dir, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: Array<{ tag: string }> };
    const upto = journal.entries.findIndex((e) => e.tag === '0010_p2a_rls');
    writeFileSync(journalPath, JSON.stringify({ ...journal, entries: journal.entries.slice(0, upto + 1) }));
    const url = urlFor(ADMIN_URL, name);
    const db = postgres(url, { max: 1, onnotice: () => {} });
    try {
      // 先迁移到 P2-A 为止（还没有 tasks.number），写入几条任务，再执行全部迁移
      await runMigrations(url, APP_PASSWORD, dir);
      const org = newId();
      const pan = newId();
      const doc = newId();
      const tieA = '0192f000-0000-7000-8000-00000000000a';
      const tieB = '0192f000-0000-7000-8000-00000000000b';
      await db`insert into organizations (id, slug, name) values (${org}, 'm', 'M')`;
      await db`insert into products (id, org_id, key, name) values (${pan}, ${org}, 'PAN', '网盘'), (${doc}, ${org}, 'DOC', '文档')`;
      await db`insert into tasks (id, org_id, product_id, title, created_at) values
        (${tieB}, ${org}, ${pan}, '同时创建乙', '2026-03-04T00:00:00Z'),
        (${tieA}, ${org}, ${pan}, '同时创建甲', '2026-03-04T00:00:00Z'),
        (${newId()}, ${org}, ${pan}, '最早', '2026-03-01T00:00:00Z'),
        (${newId()}, ${org}, ${doc}, '另一个产品', '2026-03-09T00:00:00Z')`;
      await runMigrations(url, APP_PASSWORD);
      const rows = await db<Array<{ title: string; number: number }>>`select title, number from tasks order by product_id = ${pan} desc, number`;
      expect(rows.map((r) => [r.title, r.number])).toEqual([
        ['最早', 1],
        ['同时创建甲', 2],
        ['同时创建乙', 3],
        ['另一个产品', 1],
      ]);
      const seqs = await db<Array<{ key: string; task_seq: number }>>`select key, task_seq from products order by key`;
      expect(seqs.map((s) => [s.key, s.task_seq])).toEqual([
        ['DOC', 1],
        ['PAN', 3],
      ]);
    } finally {
      await db.end();
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    }
  });
});
