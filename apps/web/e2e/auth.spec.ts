import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { acceptInvite, login, OWNER, setupInstance } from './helpers';

test.describe('初始化与登录', () => {
  test.beforeEach(async () => {
    await resetDatabase();
  });

  test('未初始化时访问首页进入向导，完成三步后进入组织', async ({ page }) => {
    await page.goto('/');
    await page.waitForURL('**/setup');
    await page.getByLabel('你的姓名').fill(OWNER.name);
    await page.getByLabel('邮箱').fill(OWNER.email);
    await page.getByLabel('密码', { exact: true }).fill(OWNER.password);
    await page.getByLabel('确认密码').fill(OWNER.password);
    await page.getByRole('button', { name: '下一步' }).click();
    await page.getByLabel('组织名称').fill('Acme Cloud');
    await expect(page.getByLabel('组织标识')).toHaveValue('acme-cloud');
    await page.getByRole('button', { name: '完成初始化' }).click();
    await expect(page.getByRole('heading', { name: '初始化完成' })).toBeVisible();
    await page.getByRole('link', { name: '进入组织' }).click();
    await page.waitForURL('**/acme-cloud');
    await expect(page.getByRole('navigation', { name: '主导航' }).getByText('成员')).toBeVisible();
    await expect(page.getByText('P2').first()).toBeVisible();
  });

  test('登录失败提示、登录成功、退出登录', async ({ page, request }) => {
    await setupInstance(request);
    await page.goto('/login');
    await page.getByLabel('邮箱').fill(OWNER.email);
    await page.getByLabel('密码').fill('wrong-password');
    await page.getByRole('button', { name: '登录' }).click();
    // Next.js 内置的路由变更播报节点也带 role="alert"，用 hasText 排除掉它，避免 strict mode 冲突。
    await expect(page.getByRole('alert').filter({ hasText: '邮箱或密码错误' })).toBeVisible();
    await login(page, OWNER.email, OWNER.password);
    await page.waitForURL('**/acme');
    await page.getByRole('button', { name: '个人菜单' }).click();
    await page.getByRole('menuitem', { name: '退出登录' }).click();
    await page.waitForURL('**/login');
    await expect(page.getByRole('link', { name: '注册' })).toHaveCount(0);
  });

  test('新用户通过邀请链接注册加入，普通成员看不到组织设置', async ({ page, request, browser }) => {
    await setupInstance(request);
    const ctx = await browser.newContext();
    const guest = await ctx.newPage();
    await acceptInvite(guest, request, {
      email: 'new@example.com',
      orgRole: 'member',
      name: '新人',
      beforeSubmit: async () => expect(guest.getByText('测试组织 邀请你加入')).toBeVisible(),
    });
    await expect(guest.getByText('组织设置')).toHaveCount(0);
    await guest.goto('/acme/settings/members');
    await expect(guest.getByRole('heading', { name: '无权访问' })).toBeVisible();
    await ctx.close();
    await page.close();
  });
});
