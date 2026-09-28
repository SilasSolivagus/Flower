import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));

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
