import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config';

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
