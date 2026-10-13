import { execFileSync } from 'node:child_process';
import path from 'node:path';
import postgres from 'postgres';

const ADMIN = 'postgres://flower_admin:flower_admin@localhost:54329';
export const E2E_DB = 'flower_e2e';
export const E2E_APP_PASSWORD = 'flower_app_test';
/**
 * 应用连接用 IP 而不是 localhost：next dev 启动后会解析 telemetry.nextjs.org 等外部域名，
 * DNS 不通时每次 getaddrinfo 占住 libuv 线程池的一个线程约 30 秒。连接池新建连接时解析
 * localhost 要排在它们后面，第一个需要第二条连接的请求就会挂起到超时。
 */
export const E2E_APP_URL = `postgres://flower_app:${E2E_APP_PASSWORD}@127.0.0.1:54329/${E2E_DB}`;
const REPO = path.resolve(__dirname, '../../..');

/** 删除并重建 flower_e2e，再用 core 的迁移 CLI 迁移。仅在 global-setup 中、任何 spec 触碰服务端之前调用一次。 */
export async function createDatabase(): Promise<void> {
  const sql = postgres(`${ADMIN}/postgres`, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(`DROP DATABASE IF EXISTS ${E2E_DB} WITH (FORCE)`);
    await sql.unsafe(`CREATE DATABASE ${E2E_DB}`);
  } finally {
    await sql.end();
  }
  execFileSync('node', ['packages/core/dist/migrate.mjs'], {
    cwd: REPO,
    stdio: 'pipe',
    env: {
      ...process.env,
      DATABASE_URL: E2E_APP_URL,
      DATABASE_ADMIN_URL: `${ADMIN}/${E2E_DB}`,
      FLOWER_APP_DB_PASSWORD: E2E_APP_PASSWORD,
      FLOWER_SECRET_KEY: 'e2e-secret-e2e-secret-e2e-secret-e2e-secret',
      FLOWER_MIGRATIONS_DIR: 'packages/core/migrations',
    },
  });
}

/**
 * 清空 flower_e2e 的业务数据，但保留数据库本身和 Playwright webServer 已建立的连接池。
 * 以 admin 角色连接后，从 pg_tables 现查 public schema 下的表名，排除 drizzle 的迁移记录表
 * （drizzle 默认存在独立的 drizzle schema 下，不在 public 里，无需按名排除），一条语句
 * TRUNCATE ... RESTART IDENTITY CASCADE 全部清空。domain_events 虽然对 flower_app 是
 * append-only（0003 撤销了 UPDATE/DELETE 权限），但 admin 角色不受限，可以 TRUNCATE。
 * 迁移本身不插入任何种子/默认行，所以清空后的状态等价于刚迁移完的数据库。
 *
 * 上一个用例的页面关闭后，服务端可能仍在处理它发出的请求。TRUNCATE 按表的顺序逐个加锁，
 * 请求事务按查询顺序逐个加锁，顺序相反时 Postgres 会报死锁（40P01）并中止其中一方；
 * 中止的是 TRUNCATE 时重试即可，请求事务结束后锁会释放。
 */
export async function resetDatabase(): Promise<void> {
  const sql = postgres(`${ADMIN}/${E2E_DB}`, { max: 1, onnotice: () => {} });
  try {
    const tables = await sql<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public'
    `;
    if (tables.length > 0) {
      const names = tables.map((t) => `"${t.tablename}"`).join(', ');
      for (let attempt = 1; ; attempt++) {
        try {
          await sql.unsafe(`TRUNCATE TABLE ${names} RESTART IDENTITY CASCADE`);
          break;
        } catch (e) {
          if (attempt >= 5 || (e as { code?: string }).code !== '40P01') throw e;
        }
      }
    }
  } finally {
    await sql.end();
  }
}

/** 以 admin 角色在 flower_e2e 上执行一条带参数的语句并返回结果行；只用于把测试数据的时间改到过去（流转历史、发布日等）。 */
export async function adminSql<T extends Record<string, unknown>>(statement: string, params: unknown[] = []): Promise<T[]> {
  const sql = postgres(`${ADMIN}/${E2E_DB}`, { max: 1, onnotice: () => {} });
  try {
    return (await sql.unsafe(statement, params as never[])) as unknown as T[];
  } finally {
    await sql.end();
  }
}
