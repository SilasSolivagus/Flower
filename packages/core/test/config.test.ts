import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, loadServerConfig } from '../src/config';

const full = {
  DATABASE_URL: 'postgres://a',
  DATABASE_ADMIN_URL: 'postgres://b',
  FLOWER_APP_DB_PASSWORD: 'pw',
  FLOWER_SECRET_KEY: 'x'.repeat(48),
};

describe('loadConfig', () => {
  it('缺少变量时列出全部缺失项', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(/DATABASE_URL.*FLOWER_SECRET_KEY/);
  });

  it('密钥过短时拒绝', () => {
    expect(() => loadConfig({ ...full, FLOWER_SECRET_KEY: 'short' })).toThrow(/至少 32 个字符/);
  });

  it('变量齐全时返回配置', () => {
    const c = loadConfig({ ...full, NODE_ENV: 'production' });
    expect(c.databaseUrl).toBe('postgres://a');
    expect(c.publicUrl).toBe('http://localhost:3000');
    expect(c.isProduction).toBe(true);
  });
});

describe('loadServerConfig', () => {
  const serverEnv = { DATABASE_URL: 'postgres://a', FLOWER_SECRET_KEY: 'x'.repeat(48) };

  it('只需要 DATABASE_URL 与 FLOWER_SECRET_KEY，不含超级用户凭证', () => {
    const c = loadServerConfig(serverEnv);
    expect(c).toEqual({
      databaseUrl: 'postgres://a',
      secretKey: 'x'.repeat(48),
      publicUrl: 'http://localhost:3000',
      isProduction: false,
      storageDir: path.join(process.cwd(), '.flower-storage'),
    });
  });

  it('缺少变量时报错', () => {
    expect(() => loadServerConfig({})).toThrow(ConfigError);
    expect(() => loadServerConfig({})).toThrow(/DATABASE_URL.*FLOWER_SECRET_KEY/);
  });

  it('密钥过短时拒绝', () => {
    expect(() => loadServerConfig({ ...serverEnv, FLOWER_SECRET_KEY: 'short' })).toThrow(/至少 32 个字符/);
  });

  it('附件存储目录可由 FLOWER_STORAGE_DIR 指定', () => {
    expect(loadServerConfig({ ...serverEnv, FLOWER_STORAGE_DIR: '/data/storage' }).storageDir).toBe('/data/storage');
  });
});
