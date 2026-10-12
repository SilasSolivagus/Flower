import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    globalSetup: ['../../packages/core/test/global-setup.ts'],
    testTimeout: 20_000,
    hookTimeout: 60_000,
    // 推送通道测试用 127.0.0.1 假接收端，跳过真实网址的内网检查（packages/core/test/notify-helpers.ts 同样处理）。
    env: { FLOWER_NOTIFY_ALLOW_PRIVATE: '1' },
  },
});
