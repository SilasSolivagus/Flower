import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { login, OWNER, setupInstance } from './helpers';

test.beforeEach(async ({ page, request }) => {
  await resetDatabase();
  await setupInstance(request);
  await login(page, OWNER.email, OWNER.password);
});

test('新建产品，编号前缀自动转大写且创建后只读', async ({ page }) => {
  await page.goto('/acme/settings/products');
  await page.getByRole('button', { name: '新建产品' }).click();
  await page.getByLabel('产品名称').fill('网盘');
  await page.getByLabel('编号前缀').fill('pan');
  await page.getByRole('button', { name: '创建' }).click();
  await page.waitForURL('**/settings/products/*');
  await expect(page.getByRole('heading', { name: '网盘' })).toBeVisible();
  await expect(page.getByText('PAN', { exact: true })).toBeVisible();
});

test('产品详情：复制流程为产品覆盖、覆盖字段、设置层级叫法、调整成员角色', async ({ page, request }) => {
  const p = await (await request.post('/api/v1/orgs/acme/products', { data: { name: '网盘', key: 'PAN' } })).json();
  await request.post('/api/v1/orgs/acme/members', { data: { displayName: '外部顾问' } });
  await page.goto(`/acme/settings/products/${p.product.id}`);

  await page.getByRole('tab', { name: '流程' }).click();
  await expect(page.getByText('默认流程')).toBeVisible();
  await page.getByRole('button', { name: '复制为本产品的流程' }).click();
  await page.getByRole('button', { name: '确认复制' }).click();
  await expect(page.getByText('本产品专用')).toBeVisible();

  await page.getByRole('tab', { name: '字段与层级' }).click();
  await page.getByRole('button', { name: '覆盖 优先级' }).click();
  await expect(page.getByText('产品覆盖', { exact: true })).toBeVisible();
  await page.getByLabel('第 1 层').fill('模块');
  await page.getByRole('button', { name: '保存层级叫法' }).click();
  await expect(page.getByText('已保存')).toBeVisible();

  await page.getByRole('tab', { name: '成员角色' }).click();
  await page.getByLabel('外部顾问 的产品角色').click();
  await page.getByRole('option', { name: '只读' }).click();
  await expect(page.getByText('已更新')).toBeVisible();
});
