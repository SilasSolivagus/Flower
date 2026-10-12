import { WECOM_API_BASE } from '@flower/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

const created = vi.hoisted(() => ({ deps: null as { wecomApiBase: string } | null }));
vi.mock('@/server/api', () => ({
  createApi: (deps: { wecomApiBase: string }) => {
    created.deps = deps;
    return {};
  },
}));

afterEach(() => vi.unstubAllEnvs());

describe('生产装配', () => {
  it('企业微信接口地址固定为常量，环境变量改不了', async () => {
    vi.stubEnv('FLOWER_SECRET_KEY', 'runtime-test-secret-runtime-test-secret-01');
    vi.stubEnv('DATABASE_URL', 'postgres://u:p@127.0.0.1:9/none');
    vi.stubEnv('FLOWER_STORAGE_DIR', '/tmp/flower-runtime-test-storage');
    vi.stubEnv('WECOM_API_BASE', 'http://127.0.0.1:1');
    vi.stubEnv('FLOWER_WECOM_API_BASE', 'http://127.0.0.1:1');
    const { getApi } = await import('@/server/runtime');
    getApi();
    expect(WECOM_API_BASE).toBe('https://qyapi.weixin.qq.com');
    expect(created.deps?.wecomApiBase).toBe(WECOM_API_BASE);
  });
});
