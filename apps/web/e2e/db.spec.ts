import { expect, test } from '@playwright/test';
import postgres from 'postgres';
import { E2E_DB, resetDatabase } from './db';

const ADMIN_URL = `postgres://flower_admin:flower_admin@localhost:54329/${E2E_DB}`;

// 上一个用例的页面关闭后，服务端可能仍有请求事务在跑。TRUNCATE 按表的顺序逐个加 ACCESS EXCLUSIVE 锁，
// 请求事务按自己的查询顺序逐个加 ACCESS SHARE 锁，两者顺序相反时形成死锁。这里构造这种交错，
// 要求 resetDatabase 仍然成功。
test('resetDatabase：与未结束的请求事务交错加锁时仍能清空', async () => {
  await resetDatabase();
  const sql = postgres(ADMIN_URL, { max: 2, onnotice: () => {} });
  try {
    const tables = (await sql<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`).map((t) => t.tablename);
    const first = tables[0]!;
    const last = tables[tables.length - 1]!;

    let reset: Promise<void> | undefined;
    await sql.begin(async (tx) => {
      // 请求事务先持有排在最后的表的 ACCESS SHARE 锁
      await tx.unsafe(`SELECT 1 FROM "${last}" LIMIT 1`);
      reset = resetDatabase();
      reset.catch(() => {});
      // 等 TRUNCATE 拿到前面所有表的锁，并在最后一张表上等待
      await expect
        .poll(async () => (await sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE query LIKE 'TRUNCATE%' AND wait_event_type = 'Lock'`)[0]!.n, { timeout: 10_000 })
        .toBe(1);
      // 两边的默认 deadlock_timeout 都是 1s，谁先跑死锁检测谁就可能被中止；把请求事务这侧调高，
      // 让 TRUNCATE 总是先检测到死锁并被选为受害者，用例才能稳定覆盖 resetDatabase 的重试路径。
      await tx.unsafe(`SET LOCAL deadlock_timeout = '30s'`);
      // 请求事务再读排在最前的表：与 TRUNCATE 形成环
      await tx.unsafe(`SELECT 1 FROM "${first}" LIMIT 1`);
    });
    await expect(reset!).resolves.toBeUndefined();
  } finally {
    await sql.end();
  }
});
