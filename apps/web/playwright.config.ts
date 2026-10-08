import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { E2E_APP_URL } from './e2e/db';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
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
    },
  },
});
