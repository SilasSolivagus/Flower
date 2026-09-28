import { loadConfig } from '../config';
import { runMigrations } from './migrate';

const config = loadConfig();
await runMigrations(config.databaseAdminUrl, config.appDbPassword, process.env.FLOWER_MIGRATIONS_DIR ?? 'migrations');
console.log('数据库迁移完成');
