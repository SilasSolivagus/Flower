import path from 'node:path';

export type FlowerConfig = {
  databaseUrl: string;
  databaseAdminUrl: string;
  appDbPassword: string;
  secretKey: string;
  publicUrl: string;
  isProduction: boolean;
};

export type ServerConfig = {
  databaseUrl: string;
  secretKey: string;
  publicUrl: string;
  isProduction: boolean;
  storageDir: string;
};

export class ConfigError extends Error {}

const REQUIRED = ['DATABASE_URL', 'DATABASE_ADMIN_URL', 'FLOWER_APP_DB_PASSWORD', 'FLOWER_SECRET_KEY'] as const;
const SERVER_REQUIRED = ['DATABASE_URL', 'FLOWER_SECRET_KEY'] as const;

function checkSecretKey(secretKey: string): void {
  if (secretKey.length < 32) {
    throw new ConfigError('FLOWER_SECRET_KEY 至少 32 个字符，可用 openssl rand -base64 48 生成。');
  }
}

export function loadConfig(env: Record<string, string | undefined> = process.env): FlowerConfig {
  const missing = REQUIRED.filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new ConfigError(
      `缺少环境变量：${missing.join(', ')}。FLOWER_SECRET_KEY 可用 openssl rand -base64 48 生成。`,
    );
  }
  const secretKey = env.FLOWER_SECRET_KEY as string;
  checkSecretKey(secretKey);
  return {
    databaseUrl: env.DATABASE_URL as string,
    databaseAdminUrl: env.DATABASE_ADMIN_URL as string,
    appDbPassword: env.FLOWER_APP_DB_PASSWORD as string,
    secretKey,
    publicUrl: env.FLOWER_PUBLIC_URL ?? 'http://localhost:3000',
    isProduction: env.NODE_ENV === 'production',
  };
}

/** 服务端进程只需要运行时角色的连接串和密钥，不持有超级用户凭证。 */
export function loadServerConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const missing = SERVER_REQUIRED.filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new ConfigError(
      `缺少环境变量：${missing.join(', ')}。FLOWER_SECRET_KEY 可用 openssl rand -base64 48 生成。`,
    );
  }
  const secretKey = env.FLOWER_SECRET_KEY as string;
  checkSecretKey(secretKey);
  return {
    databaseUrl: env.DATABASE_URL as string,
    secretKey,
    publicUrl: env.FLOWER_PUBLIC_URL ?? 'http://localhost:3000',
    isProduction: env.NODE_ENV === 'production',
    storageDir: env.FLOWER_STORAGE_DIR || path.join(process.cwd(), '.flower-storage'),
  };
}
