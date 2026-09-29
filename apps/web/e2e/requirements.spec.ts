import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { login, OWNER, setupInstance } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

async function createProduct(request: import('@playwright/test').APIRequestContext) {
  const res = await request.post('/api/v1/orgs/acme/products', { data: { name: '网盘', key: 'PAN' } });
  return (await res.json()).product.id as string;
}

test('需求列表：新建、按状态和优先级筛选、搜索编号', async ({ page, request }) => {
  const productId = await createProduct(request);
  const fields = (await (await request.get('/api/v1/orgs/acme/fields')).json()).fields;
  const p0 = fields.find((f: { key: string }) => f.key === 'priority').options.find((o: { key: string }) => o.key === 'p0').id;
  await request.post(`/api/v1/orgs/acme/products/${productId}/requirements`, { data: { title: '回收站保留 30 天', fields: { priority: [p0] } } });

  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme/requirements');
  await expect(page.getByRole('heading', { name: '需求' })).toBeVisible();
  await expect(page.getByRole('tab', { name: /全部/ })).toContainText('1');

  await page.getByRole('button', { name: '新建需求' }).click();
  await page.getByLabel('标题').fill('分享链接支持设置密码');
  await page.getByRole('combobox', { name: '优先级' }).click();
  await page.getByRole('option', { name: 'P1' }).click();
  await page.getByRole('button', { name: '创建' }).click();
  await expect(page.getByText('已创建 PAN-2')).toBeVisible();
  await expect(page.getByRole('link', { name: '分享链接支持设置密码' })).toBeVisible();
  await expect(page.getByRole('tab', { name: /全部/ })).toContainText('2');

  await page.getByRole('button', { name: /^优先级/ }).click();
  await page.getByRole('checkbox', { name: 'P0' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('link', { name: '回收站保留 30 天' })).toBeVisible();
  await expect(page.getByRole('link', { name: '分享链接支持设置密码' })).toHaveCount(0);
  await expect(page).toHaveURL(/priority=/);

  await page.goto('/acme/requirements');
  await page.getByLabel('搜索需求').fill('PAN-2');
  await expect(page.getByRole('link', { name: '分享链接支持设置密码' })).toBeVisible();
  await expect(page.getByRole('link', { name: '回收站保留 30 天' })).toHaveCount(0);

  await page.goto('/acme/requirements');
  await page.getByRole('tab', { name: /待开始/ }).click();
  await expect(page.getByText('没有符合条件的需求')).toBeVisible();
});

test('搜索框防抖期间切换其他筛选不丢失已输入的文字', async ({ page, request }) => {
  const productId = await createProduct(request);
  const fields = (await (await request.get('/api/v1/orgs/acme/fields')).json()).fields;
  const p0 = fields.find((f: { key: string }) => f.key === 'priority').options.find((o: { key: string }) => o.key === 'p0').id;
  await request.post(`/api/v1/orgs/acme/products/${productId}/requirements`, { data: { title: '回收站保留 30 天', fields: { priority: [p0] } } });

  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme/requirements');
  await page.getByLabel('搜索需求').fill('回收站');
  await page.getByRole('button', { name: /^优先级/ }).click();
  await page.getByRole('checkbox', { name: 'P0' }).click();
  await page.keyboard.press('Escape');

  await expect(page).toHaveURL(/q=/);
  await expect(page).toHaveURL(/priority=/);
  await expect(page.getByLabel('搜索需求')).toHaveValue('回收站');
});

test('导航中的"需求"可以点击', async ({ page, request }) => {
  await createProduct(request);
  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme');
  await page.getByRole('link', { name: '需求' }).click();
  await expect(page).toHaveURL(/\/acme\/requirements/);
});
