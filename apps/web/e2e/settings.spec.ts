import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { login, OWNER, setupInstance } from './helpers';

test.beforeEach(async ({ page, request }) => {
  await resetDatabase();
  await setupInstance(request);
  await login(page, OWNER.email, OWNER.password);
});

test('修改组织名称后侧栏同步更新', async ({ page }) => {
  await page.goto('/acme/settings/general');
  await page.getByLabel('组织名称').fill('123云盘');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText('已保存')).toBeVisible();
  await expect(page.getByRole('navigation', { name: '主导航' }).getByText('123云盘')).toBeVisible();
});

test('个人设置：改名、修改密码后用新密码登录', async ({ page }) => {
  await page.goto('/settings');
  await page.getByLabel('姓名').fill('林澄 Lin');
  await page.getByRole('button', { name: '保存资料' }).click();
  await expect(page.getByText('已保存')).toBeVisible();
  await page.getByLabel('当前密码').fill(OWNER.password);
  await page.getByLabel('新密码', { exact: true }).fill('password456');
  await page.getByLabel('确认新密码').fill('password456');
  await page.getByRole('button', { name: '修改密码' }).click();
  await expect(page.getByText('密码已修改')).toBeVisible();
  await page.getByRole('button', { name: '个人菜单' }).click();
  await page.getByRole('menuitem', { name: '退出登录' }).click();
  await login(page, OWNER.email, 'password456');
});

test('实例设置：开放注册后登录页出现注册入口', async ({ page, browser }) => {
  await page.goto('/admin');
  await page.getByRole('switch', { name: '开放注册' }).click();
  await expect(page.getByText('已保存')).toBeVisible();
  const ctx = await browser.newContext();
  const anon = await ctx.newPage();
  await anon.goto('/login');
  await expect(anon.getByRole('link', { name: '注册' })).toBeVisible();
  await ctx.close();
});
