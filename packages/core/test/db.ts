import postgres from 'postgres';
import { createDb, type Db } from '../src/db/client';

export const ADMIN_URL = process.env.TEST_ADMIN_URL ?? 'postgres://flower_admin:flower_admin@localhost:54329/postgres';
export const TEMPLATE_DB = 'flower_test_template';
export const APP_PASSWORD = 'flower_app_test';

export function urlFor(base: string, dbName: string, user?: { name: string; password: string }): string {
  const u = new URL(base);
  u.pathname = `/${dbName}`;
  if (user) {
    u.username = user.name;
    u.password = user.password;
  }
  return u.toString();
}

async function adminExec(statement: string): Promise<void> {
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(statement);
  } finally {
    await admin.end();
  }
}

/** 从已迁移的模板库克隆出一个独立数据库；db 以 flower_app 身份连接（受 RLS 约束），adminDb 以超级用户连接。 */
export async function createTestDb(): Promise<{ db: Db; adminDb: Db; cleanup: () => Promise<void> }> {
  const name = `flower_t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  await adminExec(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE_DB}`);
  const app = createDb(urlFor(ADMIN_URL, name, { name: 'flower_app', password: APP_PASSWORD }), { max: 4 });
  const admin = createDb(urlFor(ADMIN_URL, name), { max: 2 });
  return {
    db: app.db,
    adminDb: admin.db,
    async cleanup() {
      await app.close();
      await admin.close();
      await adminExec(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    },
  };
}
