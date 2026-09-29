import { execFileSync } from 'node:child_process';
import path from 'node:path';
import postgres from 'postgres';

const ADMIN = 'postgres://flower_admin:flower_admin@localhost:54329';
export const E2E_DB = 'flower_e2e';
export const E2E_APP_PASSWORD = 'flower_app_test';
export const E2E_APP_URL = `postgres://flower_app:${E2E_APP_PASSWORD}@localhost:54329/${E2E_DB}`;
const REPO = path.resolve(__dirname, '../../..');

/** 删除并重建 flower_e2e，再用 core 的迁移 CLI 迁移。服务端连接池会在下次查询时自动重连。 */
export async function resetDatabase(): Promise<void> {
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
