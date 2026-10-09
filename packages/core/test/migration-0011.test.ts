import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, runMigrations } from '../src/db/migrate';
import { ADMIN_URL, APP_PASSWORD, urlFor } from './db';

const DB_NAME = `flower_m11_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
const ORG = '00000000-0000-4000-8000-000000000001';
const PA = '00000000-0000-4000-8000-0000000000a1';
const PB = '00000000-0000-4000-8000-0000000000b1';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function adminExec(statement: string): Promise<void> {
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(statement);
  } finally {
    await admin.end();
  }
}

/** 复制迁移目录，只保留 0011 之前的迁移，用来造出「升级前」的库。 */
function migrationsBefore0011(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'flower-migrations-'));
  cpSync(MIGRATIONS_DIR, dir, { recursive: true });
  const journalPath = path.join(dir, 'meta/_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((e) => e.idx < 11);
  writeFileSync(journalPath, JSON.stringify(journal));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('迁移 0011：同一产品内常规迭代重名', () => {
  const url = urlFor(ADMIN_URL, DB_NAME);
  let sql: postgres.Sql;

  beforeAll(async () => {
    await adminExec(`CREATE DATABASE ${DB_NAME}`);
    const before = migrationsBefore0011();
    try {
      await runMigrations(url, APP_PASSWORD, before.dir);
    } finally {
      before.cleanup();
    }
    sql = postgres(url, { max: 1, onnotice: () => {} });
    await sql`insert into organizations (id, slug, name) values (${ORG}, 'm11', '迁移测试')`;
    await sql`insert into products (id, org_id, key, name) values (${PA}, ${ORG}, 'A', '产品甲'), (${PB}, ${ORG}, 'B', '产品乙')`;
    const it = (n: number, productId: string | null, name: string, createdAt: string, deletedAt: string | null = null) => ({
      id: id(n),
      org_id: ORG,
      product_id: productId,
      type: productId ? 'regular' : 'special',
      name,
      // 同一产品的常规迭代日期不能重叠，每个迭代各占一个月
      start_date: `2025-${String(n).padStart(2, '0')}-01`,
      end_date: `2025-${String(n).padStart(2, '0')}-20`,
      created_at: createdAt,
      deleted_at: deletedAt,
    });
    await sql`insert into iterations ${sql([
      // 产品甲：三个「迭代一」，其中两个创建时间相同（按 id 排序），另有一个已占用「迭代一（2）」
      it(3, PA, '迭代一', '2026-01-02T00:00:00Z'),
      it(2, PA, '迭代一', '2026-01-02T00:00:00Z'),
      it(1, PA, '迭代一', '2026-01-03T00:00:00Z'),
      it(4, PA, '迭代一（2）', '2026-01-04T00:00:00Z'),
      // 已删除的同名迭代不参与去重，也不占用名称
      it(5, PA, '迭代一', '2026-01-01T00:00:00Z', '2026-01-05T00:00:00Z'),
      it(6, PA, '迭代二', '2026-01-01T00:00:00Z'),
      // 其他产品和专项迭代里的同名不受影响
      it(7, PB, '迭代一', '2026-01-01T00:00:00Z'),
      it(8, null, '迭代一', '2026-01-01T00:00:00Z'),
      it(9, null, '迭代一', '2026-01-01T00:00:00Z'),
    ])}`;
    await runMigrations(url, APP_PASSWORD);
  });

  afterAll(async () => {
    await sql?.end();
    await adminExec(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
  });

  it('第 2 个起改名为「名称（N）」，N 跳过已占用的名称', async () => {
    const rows = await sql<{ id: string; name: string }[]>`select id, name from iterations order by id`;
    expect(Object.fromEntries(rows.map((r) => [r.id, r.name]))).toEqual({
      [id(1)]: '迭代一（4）',
      [id(2)]: '迭代一',
      [id(3)]: '迭代一（3）',
      [id(4)]: '迭代一（2）',
      [id(5)]: '迭代一',
      [id(6)]: '迭代二',
      [id(7)]: '迭代一',
      [id(8)]: '迭代一',
      [id(9)]: '迭代一',
    });
  });

  it('唯一索引已建立', async () => {
    await expect(
      sql`insert into iterations (id, org_id, product_id, type, name, start_date, end_date) values (${id(10)}, ${ORG}, ${PA}, 'regular', '迭代二', '2025-12-01', '2025-12-20')`,
    ).rejects.toThrow(/iterations_product_name/);
  });
});
