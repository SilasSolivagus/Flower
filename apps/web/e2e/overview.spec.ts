import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { login, OWNER, setupInstance } from './helpers';

test.beforeEach(async () => {
  await resetDatabase();
});

test('只有一个组织时登录后进入该组织的工作台；概览页显示产品与管理员的配置清单', async ({ page, request }) => {
  await setupInstance(request);
  await login(page, OWNER.email, OWNER.password);
  await page.waitForURL('**/acme');
  await expect(page.getByRole('heading', { name: '工作台', level: 1 })).toBeVisible();
  await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '概览' }).click();
  await expect(page).toHaveURL(/\/acme\/overview$/);
  await expect(page.getByRole('heading', { name: '测试组织' })).toBeVisible();
  const list = page.getByRole('list', { name: '组织配置清单' });
  await expect(list.getByRole('listitem')).toHaveCount(6);
  await expect(page.getByText('已完成 0 / 6')).toBeVisible();
  await request.post('/api/v1/orgs/acme/products', { data: { name: '网盘', key: 'PAN' } });
  await page.reload();
  await expect(page.getByText('已完成 1 / 6')).toBeVisible();
  await expect(page.getByRole('link', { name: /网盘/ }).filter({ hasText: 'PAN' })).toBeVisible();
});
