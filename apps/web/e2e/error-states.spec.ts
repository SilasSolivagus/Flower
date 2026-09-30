import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { acceptInvite, createProduct, FAIL_500, login, OWNER, setupInstance } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

test('账号信息加载失败（5xx）时显示重试，恢复后进入页面', async ({ page }) => {
  await login(page, OWNER.email, OWNER.password);
  await page.route('**/api/v1/me', (route) => route.fulfill(FAIL_500));
  await page.goto('/acme/requirements');
  await expect(page.getByText('加载账号信息失败，请重试。')).toBeVisible({ timeout: 15_000 });
  await page.unroute('**/api/v1/me');
  await page.getByRole('button', { name: '重试' }).click();
  await expect(page.getByRole('heading', { name: '需求' })).toBeVisible();
});

test('产品设置加载失败（5xx）显示重试，不显示无权访问', async ({ page, request }) => {
  const productId = await createProduct(request);
  await login(page, OWNER.email, OWNER.password);
  await page.route(`**/api/v1/orgs/acme/products/${productId}`, (route) => route.fulfill(FAIL_500));
  await page.goto(`/acme/settings/products/${productId}`);
  await expect(page.getByText('加载产品失败，请重试。')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('heading', { name: '无权访问' })).toHaveCount(0);
  await page.unroute(`**/api/v1/orgs/acme/products/${productId}`);
  await page.getByRole('button', { name: '重试' }).click();
  await expect(page.getByRole('heading', { name: '网盘' })).toBeVisible();
});

test('网络断开时，保存操作提示「网络连接失败」', async ({ page, request }) => {
  const productId = await createProduct(request);
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/settings/products/${productId}`);
  await expect(page.getByRole('heading', { name: '网盘' })).toBeVisible();
  await page.route(`**/api/v1/orgs/acme/products/${productId}`, (route) =>
    route.request().method() === 'PATCH' ? route.abort('internetdisconnected') : route.continue(),
  );
  await page.getByLabel('产品名称').fill('网盘二期');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText('网络连接失败，请检查网络后重试')).toBeVisible();
});

test('非实例管理员打开 /admin：显示无权访问，页面只有一个一级标题', async ({ browser, request }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await acceptInvite(page, request, { email: 'member@example.com', orgRole: 'member', name: '成员甲' });
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: '无权访问' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await ctx.close();
});
