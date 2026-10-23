import { ConfigError, loadConfig, loadServerConfig } from '../config';
import { runMigrations } from './migrate';
import { checkSchema, dbTarget, formatSchemaServiceFailure, GateError, missingAdminUrlMessage } from './schema-gate';

const migrationsDir = process.env.FLOWER_MIGRATIONS_DIR ?? 'migrations';
const check = process.argv.includes('--check');

function failLine(error: unknown): string {
  if (error instanceof Error) return error.message.split('\n')[0] || '启动失败';
  return '启动失败';
}

try {
  if (check) {
    const config = loadServerConfig();
    await checkSchema(config.databaseUrl, migrationsDir);
  } else {
    const adminUrl = process.env.DATABASE_ADMIN_URL;
    if (!adminUrl) {
      console.error(missingAdminUrlMessage());
      process.exit(1);
    }
    const config = loadConfig();
    if (!dbTarget(config.databaseAdminUrl)) {
      console.error('[Flower schema] 连不上数据库（连接串无法解析，没有主机名）。下一步：检查 DATABASE_ADMIN_URL 格式（postgres://账号:密码@主机:端口/库名）');
      process.exit(1);
    }
    const started = Date.now();
    try {
      await runMigrations(config.databaseAdminUrl, config.appDbPassword, migrationsDir);
    } catch (error) {
      if (error instanceof ConfigError) throw error;
      console.error(formatSchemaServiceFailure(error, adminUrl, started));
      process.exit(1);
    }
    console.log('数据库迁移完成');
  }
} catch (error) {
  console.error(check ? `[Flower 启动检查] ${failLine(error)}` : failLine(error));
  process.exit(1);
}
