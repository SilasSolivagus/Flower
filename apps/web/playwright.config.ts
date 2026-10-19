import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { E2E_APP_URL } from './e2e/db';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  // CI 默认的 github 报告要等结束才列出用例；line 逐条打出，超时时能看到停在哪一条。
  reporter: process.env.CI ? [['github'], ['line']] : [['list']],
  globalSetup: './e2e/global-setup.ts',
  use: { baseURL: 'http://localhost:3100', locale: 'zh-CN', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: 'pnpm exec next dev --port 3100',
    port: 3100,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      DATABASE_URL: E2E_APP_URL,
      FLOWER_SECRET_KEY: 'e2e-secret-e2e-secret-e2e-secret-e2e-secret',
      FLOWER_PUBLIC_URL: 'http://localhost:3100',
      FLOWER_STORAGE_DIR: path.join(__dirname, 'test-results', 'e2e-storage'),
      // 推送：不启动后台循环，用例通过 POST /api/v1/instance/notifications/tick 驱动
      FLOWER_NOTIFY_WORKER: 'off',
      FLOWER_NOTIFY_TICK_API: '1',
      // 推送：接受本机假接收端（127.0.0.1）的地址，不按生产环境拒绝内网地址
      FLOWER_NOTIFY_ALLOW_PRIVATE: '1',
    },
  },
});
