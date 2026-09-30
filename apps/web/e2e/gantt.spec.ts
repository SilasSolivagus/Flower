import { expect, type Page, test } from '@playwright/test';
import { resetDatabase } from './db';
import { createIteration, createProduct, createRequirement, createTask, FAIL_500, login, OWNER, setupInstance } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

const taskSaved = (page: Page) => page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().includes('/api/v1/orgs/acme/tasks/'));

test('甘特页签：失焦保存别名与进度，标记关注后计入遗留，非法工期提示并还原', async ({ page, request }) => {
  const productId = await createProduct(request);
  const req = await createRequirement(request, productId, '上传提速');
  // 迭代在测试运行时已结束，理论进度为 100%；进度用手动值，结果不依赖运行日期
  const iterationId = await createIteration(request, productId, '迭代0105', '2026-01-05', '2026-01-16');
  await createTask(request, { iterationId, requirementId: req.id, title: '前端开发', planStart: '2026-01-05', planDays: 2 });
  await createTask(request, { iterationId, title: '联调', progress: 20 });

  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/iterations/${iterationId}?tab=gantt`);
  const overview = page.getByRole('region', { name: '进度概览' });
  await expect(overview.getByRole('group', { name: '理论进度' })).toContainText('100%');
  await expect(overview.getByRole('group', { name: '遗留' })).toContainText('0 项');

  const alias = page.getByLabel('别名 前端开发');
  await alias.fill('前端');
  const aliasSaved = taskSaved(page);
  await alias.blur();
  expect((await aliasSaved).ok()).toBeTruthy();

  const progress = page.getByLabel('进度 联调', { exact: true });
  await progress.fill('60');
  const progressSaved = taskSaved(page);
  await progress.blur();
  expect((await progressSaved).ok()).toBeTruthy();
  await expect(page.getByRole('progressbar', { name: '联调 进度' })).toHaveAttribute('aria-valuenow', '60');

  await page.getByRole('combobox', { name: '标记 联调' }).click();
  await page.getByRole('option', { name: '关注' }).click();
  await expect(overview.getByRole('group', { name: '遗留' })).toContainText('1 项');
  await expect(page.getByRole('list', { name: '关注与周知' })).toContainText('联调');

  const days = page.getByLabel('工期 联调');
  await days.fill('0.3');
  await days.blur();
  await expect(page.getByText('工期以半天为单位，范围 0.5–365 天')).toBeVisible();
  await expect(page.getByLabel('工期 联调')).toHaveValue('');

  await page.reload();
  await expect(page.getByLabel('别名 前端开发')).toHaveValue('前端');
  await expect(page.getByLabel('进度 联调', { exact: true })).toHaveValue('60');
});

test('甘特页签：保存一个字段时，同一行正在编辑的另一个字段不丢失', async ({ page, request }) => {
  const productId = await createProduct(request);
  const iterationId = await createIteration(request, productId, '迭代0105', '2026-01-05', '2026-01-16');
  await createTask(request, { iterationId, title: '联调' });

  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/iterations/${iterationId}?tab=gantt`);

  const alias = page.getByLabel('别名 联调');
  const note = page.getByLabel('说明 联调');
  const aliasSaved = taskSaved(page);
  const ganttRefetched = page.waitForResponse((r) => r.request().method() === 'GET' && r.url().includes(`/iterations/${iterationId}/gantt`));
  await alias.fill('联调-别名');
  // 别名失焦后触发保存；不等它完成，趁刷新还没落地就去编辑同一行的说明字段
  await alias.blur();
  await note.click();
  await note.type('等前端联调完成');
  await aliasSaved;
  await ganttRefetched;
  await expect(note).toHaveValue('等前端联调完成');
  await expect(alias).toHaveValue('联调-别名');
});

test('甘特页签：每个迭代最多 10 个重点任务；新增与删除不挂需求的任务', async ({ page, request }) => {
  const productId = await createProduct(request);
  const iterationId = await createIteration(request, productId, '迭代0105', '2026-01-05', '2026-01-16');
  for (let i = 1; i <= 10; i++) await createTask(request, { iterationId, title: `重点${i}`, starred: true });
  await createTask(request, { iterationId, title: '联调' });

  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/iterations/${iterationId}?tab=gantt`);
  await expect(page.getByText('重点 10/10')).toBeVisible();
  await page.getByRole('button', { name: '标为重点 联调' }).click();
  await expect(page.getByText('每个迭代最多 10 个重点任务')).toBeVisible();
  await page.getByRole('button', { name: '取消重点 重点1', exact: true }).click();
  await expect(page.getByText('重点 9/10')).toBeVisible();
  await page.getByRole('button', { name: '标为重点 联调' }).click();
  await expect(page.getByRole('button', { name: '取消重点 联调' })).toBeVisible();

  await page.getByRole('button', { name: '＋ 任务' }).click();
  await page.getByLabel('新任务名称').fill('埋点');
  await page.getByRole('button', { name: '添加' }).click();
  await expect(page.getByText('已添加任务')).toBeVisible();
  await expect(page.getByLabel('别名 埋点')).toBeVisible();
  await page.getByRole('button', { name: '删除 埋点' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '删除' }).click();
  await expect(page.getByText('已删除任务')).toBeVisible();
  await expect(page.getByLabel('别名 联调')).toBeVisible();
  await expect(page.getByLabel('别名 埋点')).toHaveCount(0);
});

test('甘特页签：加载失败（5xx）显示重试', async ({ page, request }) => {
  const productId = await createProduct(request);
  const iterationId = await createIteration(request, productId, '迭代0105', '2026-01-05', '2026-01-16');
  await login(page, OWNER.email, OWNER.password);
  await page.route(`**/api/v1/orgs/acme/iterations/${iterationId}/gantt`, (route) => route.fulfill(FAIL_500));
  await page.goto(`/acme/iterations/${iterationId}?tab=gantt`);
  await expect(page.getByText('加载甘特失败，请重试。')).toBeVisible({ timeout: 15_000 });
  await page.unroute(`**/api/v1/orgs/acme/iterations/${iterationId}/gantt`);
  await page.getByRole('button', { name: '重试' }).click();
  await expect(page.getByText('还没有任务')).toBeVisible();
});
