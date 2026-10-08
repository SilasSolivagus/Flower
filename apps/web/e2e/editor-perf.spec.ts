import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { resetDatabase } from './db';
import { syntheticPrd } from './fixtures/large-prd';

/** 设计决定「大文档性能基线」的阈值：加载中位数与输入延迟 p95。 */
const LOAD_MS = 1500;
const KEY_P95_MS = 50;
const SIZES = [20_000, 40_000, 80_000, 160_000];
const RUNS = 5;
const KEYS = 30;

type Row = { name: string; chars: number; loadMs: number; keyP95: number };

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * 0.95))]!;

async function measure(page: Page, name: string, markdown: string): Promise<Row> {
  await page.addInitScript((md) => {
    window.__BENCH_MARKDOWN__ = md;
  }, markdown);
  const loads: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    await page.goto('/dev/editor-bench');
    await page.waitForSelector('body[data-bench-ready="1"]', { timeout: 120_000 });
    loads.push(await page.evaluate(() => window.__BENCH__!.mountMs));
  }
  // 懒加载模式下先展开最后一个小节再输入
  const collapsed = page.locator('[data-section-toggle][aria-expanded="false"]');
  if ((await collapsed.count()) > 0) await collapsed.last().click();
  await page.locator('.bn-block-content').last().click();
  await page.keyboard.press('End');
  await page.evaluate(() => {
    const w = window as unknown as { __keys: number[] };
    w.__keys = [];
    document.addEventListener(
      'keydown',
      () => {
        const t0 = performance.now();
        requestAnimationFrame(() => setTimeout(() => w.__keys.push(performance.now() - t0), 0));
      },
      true,
    );
  });
  // 用 ASCII 字符：Playwright 对无对应物理键的字符（如中文）走 CDP insertText，不派发 keydown，测不到延迟
  await page.keyboard.type('a'.repeat(KEYS), { delay: 60 });
  await page.waitForTimeout(500);
  const keys = await page.evaluate(() => (window as unknown as { __keys: number[] }).__keys);
  return { name, chars: markdown.length, loadMs: Math.round(median(loads)), keyP95: Math.round(p95(keys)) };
}

test.beforeEach(async () => {
  await resetDatabase();
});

test('大文档基线：合成文档与本地旧 PRD 的加载时间、输入延迟', async ({ page }) => {
  // 跑一次要几分钟，只在显式开启时运行（Task 1 基线、Task 18 复测）；日常的全量端到端不跑
  test.skip(process.env.EDITOR_BENCH !== '1', '设置 EDITOR_BENCH=1 时运行');
  test.setTimeout(900_000);
  const rows: Row[] = [];
  for (const size of SIZES) rows.push(await measure(page, `合成 ${size}`, syntheticPrd(size)));
  // 本地真实旧 PRD 只在 .local-data/perf/ 存在时测（不提交）；用逗号分隔多个文件
  for (const file of (process.env.BENCH_FILES ?? '').split(',').filter(Boolean)) {
    if (existsSync(file)) rows.push(await measure(page, path.basename(file), readFileSync(file, 'utf8')));
  }
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/editor-perf.json', `${JSON.stringify(rows, null, 2)}\n`);
  console.log(['| 文档 | 字符数 | 加载中位数 (ms) | 输入 p95 (ms) |', '|---|---|---|---|', ...rows.map((r) => `| ${r.name} | ${r.chars} | ${r.loadMs} | ${r.keyP95} |`)].join('\n'));
  const at80 = rows.find((r) => r.name === '合成 80000')!;
  expect(at80.loadMs, '80k 合成文档的加载中位数').toBeLessThanOrEqual(LOAD_MS);
  expect(at80.keyP95, '80k 合成文档的输入延迟 p95').toBeLessThanOrEqual(KEY_P95_MS);
});
