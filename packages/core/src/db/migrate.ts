import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { CONNECT_TIMEOUT_SEC, dbTarget } from './schema-gate';

// 用 path.join 而非 `new URL('../../migrations', import.meta.url)`：后者是 Turbopack/webpack
// 识别的静态资源引用写法，构建 apps/web（transpilePackages 包含 @flower/core）时会把
// migrations 目录当模块解析，报 "Module not found"。
export const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');

export function quoteLiteral(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

/** 以超级用户执行迁移，然后为运行时角色 flower_app 设置密码。 */
export async function runMigrations(
  adminUrl: string,
  appDbPassword: string,
  migrationsFolder: string = MIGRATIONS_DIR,
): Promise<void> {
  if (!dbTarget(adminUrl)) throw new Error('数据库管理连接串无法解析，没有主机名');
  const client = postgres(adminUrl, { max: 1, connect_timeout: CONNECT_TIMEOUT_SEC, onnotice: () => {} });
  try {
    await migrate(drizzle({ client }), { migrationsFolder });
    await client.unsafe(`ALTER ROLE flower_app WITH LOGIN PASSWORD ${quoteLiteral(appDbPassword)}`);
    await client.unsafe('GRANT USAGE ON SCHEMA drizzle TO flower_app');
    await client.unsafe('GRANT SELECT ON drizzle.__drizzle_migrations TO flower_app');
  } finally {
    await client.end();
  }
}
