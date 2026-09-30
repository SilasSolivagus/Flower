import { type APIResponse, expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { setupInstance } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

async function json<T>(pending: Promise<APIResponse>): Promise<T> {
  const res = await pending;
  expect(res.ok(), `${res.url()} → ${res.status()}`).toBeTruthy();
  return (await res.json()) as T;
}

test('访客产品管理员：从概览进入产品设置，角色页签列出成员，能编辑已覆盖字段的选项，面包屑不指向无权页面', async ({ browser, request }) => {
  const productId = (await json<{ product: { id: string } }>(request.post('/api/v1/orgs/acme/products', { data: { name: '网盘', key: 'PAN' } }))).product.id;
  await json(request.post('/api/v1/orgs/acme/members', { data: { displayName: '外部顾问' } }));
  const { token } = await json<{ token: string }>(request.post('/api/v1/orgs/acme/invitations', { data: { email: 'guest-pm@example.com', orgRole: 'guest' } }));

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`/invite/${token}`);
  await page.getByLabel('你的姓名').fill('访客管理员');
  await page.getByLabel('设置密码').fill('password123');
  await page.getByRole('button', { name: '接受邀请' }).click();
  await page.waitForURL('**/acme');

  const members = (await json<{ members: Array<{ id: string; displayName: string }> }>(request.get('/api/v1/orgs/acme/members'))).members;
  const guestId = members.find((m) => m.displayName === '访客管理员')!.id;
  const res = await request.put(`/api/v1/orgs/acme/products/${productId}/roles/${guestId}`, { data: { role: 'admin' } });
  expect(res.status()).toBe(204);

  await page.reload();
  await page.getByRole('link', { name: '网盘 产品设置' }).click();
  await expect(page.getByRole('heading', { name: '网盘' })).toBeVisible();

  await page.getByRole('tab', { name: '成员角色' }).click();
  await expect(page.getByRole('combobox', { name: '外部顾问 的产品角色' })).toBeVisible();

  await page.getByRole('tab', { name: '字段与层级' }).click();
  await page.getByRole('button', { name: '覆盖 优先级' }).click();
  const priority = page.getByRole('region', { name: '优先级' });
  await priority.getByLabel('新选项').fill('绿色通道');
  await priority.getByRole('button', { name: '添加' }).click();
  await expect(priority.getByRole('textbox', { name: '选项名称' }).first()).toBeVisible();
  await expect(priority.getByRole('textbox', { name: '选项名称' })).toHaveCount(5);

  await page.getByRole('navigation', { name: '面包屑' }).getByRole('link', { name: '概览' }).click();
  await expect(page).toHaveURL(/\/acme$/);
  await expect(page.getByRole('heading', { name: '测试组织' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '无权访问' })).toHaveCount(0);
  await ctx.close();
});
