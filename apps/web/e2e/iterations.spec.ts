import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { createProduct, login, OWNER, setupInstance } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

test('迭代列表：新建常规迭代与专项，时间重叠时提示，编辑名称', async ({ page, request }) => {
  await createProduct(request);
  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme');
  await page.getByRole('link', { name: '迭代', exact: true }).click();
  await expect(page).toHaveURL(/\/acme\/iterations$/);
  await expect(page.getByText('还没有迭代')).toBeVisible();

  await page.getByRole('button', { name: '新建迭代' }).click();
  await page.getByLabel('名称', { exact: true }).fill('迭代0701');
  await page.getByLabel('开始日期').fill('2026-07-01');
  await page.getByLabel('结束日期').fill('2026-07-15');
  await page.getByRole('button', { name: '添加里程碑' }).click();
  await page.getByLabel('里程碑 1 名称').fill('发布');
  await page.getByLabel('里程碑 1 日期').fill('2026-07-15');
  await page.getByRole('button', { name: '创建' }).click();
  await expect(page.getByText('已创建迭代')).toBeVisible();
  const pan = page.getByRole('region', { name: '网盘' });
  await expect(pan.getByRole('link', { name: '迭代0701' })).toBeVisible();

  await page.getByRole('button', { name: '新建迭代' }).click();
  await page.getByLabel('名称', { exact: true }).fill('重叠的迭代');
  await page.getByLabel('开始日期').fill('2026-07-10');
  await page.getByLabel('结束日期').fill('2026-07-20');
  await page.getByRole('button', { name: '创建' }).click();
  await expect(page.getByRole('alert').filter({ hasText: '与已有迭代时间重叠' })).toBeVisible();
  await page.getByRole('button', { name: '取消' }).click();

  await page.getByRole('button', { name: '新建迭代' }).click();
  await page.getByRole('combobox', { name: '所属' }).click();
  await page.getByRole('option', { name: '专项（跨产品）' }).click();
  await page.getByLabel('名称', { exact: true }).fill('专业空间优化');
  await page.getByLabel('开始日期').fill('2026-07-01');
  await page.getByLabel('结束日期').fill('2026-09-30');
  await page.getByRole('button', { name: '创建' }).click();
  await expect(page.getByRole('region', { name: '专项' }).getByRole('link', { name: '专业空间优化' })).toBeVisible();

  await pan.getByRole('button', { name: '编辑 迭代0701' }).click();
  await expect(page.getByLabel('名称', { exact: true })).toHaveValue('迭代0701');
  await expect(page.getByLabel('里程碑 1 名称')).toHaveValue('发布');
  await page.getByLabel('名称', { exact: true }).fill('迭代0701-改');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(pan.getByRole('link', { name: '迭代0701-改' })).toBeVisible();
});

test('迭代列表：加载失败显示重试', async ({ page }) => {
  await login(page, OWNER.email, OWNER.password);
  await page.route('**/api/v1/orgs/acme/iterations', (route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'internal', message: '服务器错误' } }) }),
  );
  await page.goto('/acme/iterations');
  await expect(page.getByText('加载迭代失败，请重试。')).toBeVisible({ timeout: 15_000 });
  await page.unroute('**/api/v1/orgs/acme/iterations');
  await page.getByRole('button', { name: '重试' }).click();
  await expect(page.getByText('还没有迭代')).toBeVisible();
});
