import { execSync } from 'node:child_process';
import path from 'node:path';
import { resetDatabase } from './db';

export default async function globalSetup() {
  execSync('pnpm --filter @flower/core build:migrate', { cwd: path.resolve(__dirname, '../../..'), stdio: 'pipe' });
  await resetDatabase();
}
