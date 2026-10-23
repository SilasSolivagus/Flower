import fs from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { resetDatabase } from './db';
import { createIteration, createProduct, createRequirement, createTask, expectNoPageOverflow, login, OWNER, setupInstance } from './helpers';

const SHOTS = '/opt/cursor/artifacts/screenshots';

async function shot(page: Page, name: string) {
  if (process.env.CI || !fs.existsSync('/opt/cursor/artifacts')) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}`, fullPage: true });
}

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

async function metrics(page: Page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const table = document.querySelector('table');
    const scroller = table?.parentElement ?? null;
    const timeline = document.querySelector('[aria-label="时间轴"]');
    const overview = document.querySelector('[aria-label="进度概览"]');
    const list = document.querySelector('main section');
    const box = (el: Element | null) => (el ? Math.round(el.getBoundingClientRect().height) : null);
    return {
      pageScroll: doc.scrollWidth,
      pageClient: doc.clientWidth,
      tableScroll: scroller?.scrollWidth ?? null,
      tableClient: scroller?.clientWidth ?? null,
      tableMin: table ? getComputedStyle(table).minWidth : null,
      overviewH: box(overview),
      groups: overview ? overview.querySelectorAll('[role="group"]').length : 0,
      timelineH: box(timeline),
      listH: box(list),
      listBottom: list ? Math.round(list.getBoundingClientRect().bottom) : null,
      viewportH: window.innerHeight,
    };
  });
}

test('1280 甘特：表落在可用宽里，无任务与无开始日期走矮态', async ({ page, request }) => {
  const productId = await createProduct(request);
  const req = await createRequirement(request, productId, '一个很长的需求标题，用来检查需求与任务列不会压到负责人列');
  const emptyId = await createIteration(request, productId, '空迭代', '2027-03-01', '2027-03-12');
  const plainId = await createIteration(request, productId, '未排期', '2026-01-05', '2026-01-16');
  const label = '前端开发联调与埋点验证';
  await createTask(request, { iterationId: plainId, requirementId: req.id, title: label });
  const zeroId = await createIteration(request, productId, '全零', '2027-04-01', '2027-04-14');
  await createTask(request, { iterationId: zeroId, title: '还没排' });
  const scheduledId = await createIteration(request, productId, '有排期', '2026-02-02', '2026-02-13');
  await createTask(request, { iterationId: scheduledId, requirementId: req.id, title: '前端开发', planStart: '2026-02-02', planDays: 3, delayDays: 1 });

  await login(page, OWNER.email, OWNER.password);
  await page.setViewportSize({ width: 1280, height: 900 });

  await page.goto(`/acme/iterations/${emptyId}?tab=gantt`);
  await expect(page.getByText('还没有任务', { exact: true })).toBeVisible();
  const overview = page.getByRole('region', { name: '进度概览' });
  await expect(overview.getByRole('group')).toHaveCount(0);
  await expect(overview).toContainText('添加任务并填写开始日期后');
  const timeline = page.getByRole('region', { name: '时间轴' });
  await expect(timeline).toContainText('没有填写开始日期的任务');
  const empty = await metrics(page);
  expect(empty.overviewH).toBeLessThanOrEqual(48);
  expect(empty.timelineH).toBeLessThanOrEqual(48);
  expect(empty.groups).toBe(0);
  await expectNoPageOverflow(page);
  await shot(page, 'dux-f-iteration-detail-1280-empty.png');

  await page.goto(`/acme/iterations/${plainId}?tab=gantt`);
  await expect(page.getByLabel(`别名 ${label}`)).toBeVisible();
  await expect(page.getByRole('group', { name: '理论进度' })).toContainText('100%');
  const plain = await metrics(page);
  expect(plain.tableScroll! - plain.tableClient!).toBeLessThanOrEqual(8);
  expect(plain.timelineH).toBeLessThanOrEqual(48);
  expect(plain.groups).toBe(4);
  await expectNoPageOverflow(page);
  await shot(page, 'dux-f-iteration-detail-1280.png');

  await page.goto(`/acme/iterations/${zeroId}?tab=gantt`);
  await expect(page.getByLabel('别名 还没排')).toBeVisible();
  await expect(page.getByRole('region', { name: '进度概览' }).getByRole('group')).toHaveCount(0);
  await expect(page.getByRole('region', { name: '进度概览' })).toContainText('整体 0%');
  const zero = await metrics(page);
  expect(zero.overviewH).toBeLessThanOrEqual(48);
  expect(zero.timelineH).toBeLessThanOrEqual(48);

  await page.goto(`/acme/iterations/${scheduledId}?tab=gantt`);
  const axis = page.getByRole('region', { name: '时间轴' });
  await expect(axis.locator('[data-kind="plan"]').first()).toBeVisible();
  await expect(axis.locator('[data-kind="delay"]').first()).toBeVisible();
  const scheduled = await metrics(page);
  expect(scheduled.tableScroll! - scheduled.tableClient!).toBeLessThanOrEqual(8);
  await expectNoPageOverflow(page);
  await shot(page, 'dux-f-iteration-detail-1280-scheduled.png');
});

test('迭代列表少数据时底卡片按内容定高', async ({ page, request }) => {
  const productId = await createProduct(request);
  await createIteration(request, productId, '迭代甲', '2026-08-01', '2026-08-14');
  await createIteration(request, productId, '迭代乙', '2026-09-01', '2026-09-14');
  await login(page, OWNER.email, OWNER.password);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/acme/iterations');
  const section = page.getByRole('region', { name: '网盘' });
  await expect(section.getByRole('link', { name: '迭代甲' })).toBeVisible();
  const list = await metrics(page);
  expect(list.listH).toBeLessThan(200);
  expect(list.viewportH - list.listBottom!).toBeGreaterThan(200);
  await expectNoPageOverflow(page);
  await shot(page, 'dux-f-iterations-list-1280.png');
});
