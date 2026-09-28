export type FlowerConfig = {
  databaseUrl: string;
  databaseAdminUrl: string;
  appDbPassword: string;
  secretKey: string;
  publicUrl: string;
  isProduction: boolean;
};

export class ConfigError extends Error {}

const REQUIRED = ['DATABASE_URL', 'DATABASE_ADMIN_URL', 'FLOWER_APP_DB_PASSWORD', 'FLOWER_SECRET_KEY'] as const;

export function loadConfig(env: Record<string, string | undefined> = process.env): FlowerConfig {
  const missing = REQUIRED.filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new ConfigError(
      `缺少环境变量：${missing.join(', ')}。FLOWER_SECRET_KEY 可用 openssl rand -base64 48 生成。`,
    );
  }
  const secretKey = env.FLOWER_SECRET_KEY as string;
  if (secretKey.length < 32) {
    throw new ConfigError('FLOWER_SECRET_KEY 至少 32 个字符，可用 openssl rand -base64 48 生成。');
  }
  return {
    databaseUrl: env.DATABASE_URL as string,
    databaseAdminUrl: env.DATABASE_ADMIN_URL as string,
    appDbPassword: env.FLOWER_APP_DB_PASSWORD as string,
    secretKey,
    publicUrl: env.FLOWER_PUBLIC_URL ?? 'http://localhost:3000',
    isProduction: env.NODE_ENV === 'production',
  };
}
