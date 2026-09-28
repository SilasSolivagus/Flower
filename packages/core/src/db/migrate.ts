import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

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
  const client = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle({ client }), { migrationsFolder });
    await client.unsafe(`ALTER ROLE flower_app WITH LOGIN PASSWORD ${quoteLiteral(appDbPassword)}`);
  } finally {
    await client.end();
  }
}
