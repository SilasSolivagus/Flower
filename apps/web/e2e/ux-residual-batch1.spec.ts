import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { acceptInvite, createProduct, createRequirement, expectNoPageOverflow, json, login, ok, OWNER, setupInstance } from './helpers';

test.beforeEach(async () => {
  await resetDatabase();
});

test('G1：760 汉堡抽屉默认关闭并盖住主列，Esc、遮罩、收起和点导航都能关上；1280 仍是文字侧栏', async ({ page, request }) => {
  await setupInstance(request);
  const created = await json<{ workItem: { displayKey: string } }>(request.post('/api/v1/orgs/acme/work-items', { data: { title: '协助客服排查' } }));
  await login(page, OWNER.email, OWNER.password);

  await page.setViewportSize({ width: 760, height: 900 });
  await page.goto('/acme');
  const nav = page.getByRole('navigation', { name: '主导航' });
  const main = page.locator('main');
  await expect(nav).toBeHidden();
  await expect(page.getByRole('button', { name: '打开导航' })).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('heading', { name: '工作台', level: 1 })).toBeVisible();
  expect((await main.boundingBox())!.x).toBeLessThan(40);
  await expectNoPageOverflow(page);

  await page.getByRole('button', { name: '打开导航' }).click();
  await expect(nav).toBeVisible();
  const openNav = (await nav.boundingBox())!;
  expect(openNav.width).toBeGreaterThan(200);
  expect(openNav.width).toBeLessThan(280);
  expect((await main.boundingBox())!.x).toBeLessThan(40);
  for (const label of ['工作台', '概览', '看板', '需求', '跟进', '迭代', '评审', '文档']) {
    await expect(nav.getByRole('link', { name: label, exact: true })).toBeVisible();
  }
  await expect(nav.getByRole('link', { name: '工作台', exact: true })).toHaveAttribute('aria-current', 'page');

  await page.keyboard.press('Escape');
  await expect(nav).toBeHidden();
  await page.getByRole('button', { name: '打开导航' }).click();
  await page.getByRole('button', { name: '关闭导航' }).click();
  await expect(nav).toBeHidden();
  await page.getByRole('button', { name: '打开导航' }).click();
  await page.getByRole('button', { name: '收起导航' }).click();
  await expect(nav).toBeHidden();

  await page.getByRole('button', { name: '打开导航' }).click();
  await nav.getByRole('link', { name: '需求', exact: true }).click();
  await expect(page).toHaveURL(/\/acme\/requirements$/);
  await expect(nav).toBeHidden();
  await page.getByRole('button', { name: '打开导航' }).click();
  await expect(nav.getByRole('link', { name: '需求', exact: true })).toHaveAttribute('aria-current', 'page');
  await nav.getByRole('button', { name: '组织设置' }).click();
  await expect(nav.getByRole('link', { name: '成员' })).toBeVisible();

  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.getByRole('button', { name: '打开导航' })).toBeHidden();
  await expect(nav).toBeVisible();
  expect((await nav.boundingBox())!.width).toBeGreaterThan(200);
  await page.goto(`/acme/work-items/${created.workItem.displayKey}`);
  await expect(nav.locator('a[href="/acme/tracking"]')).toHaveAttribute('aria-current', 'page');
});

test('G2：760 需求列表标题可读并能打开详情', async ({ page, request }) => {
  await setupInstance(request);
  const productId = await createProduct(request);
  const title = '这是一个很长的需求标题用来确认窄屏下列表不会把标题挤成几个字';
  const req = await createRequirement(request, productId, title);
  await login(page, OWNER.email, OWNER.password);
  await page.setViewportSize({ width: 760, height: 900 });
  await page.goto('/acme/requirements');
  const cell = page.getByRole('cell', { name: title });
  await expect(cell).toBeVisible();
  expect((await cell.boundingBox())!.width).toBeGreaterThan(160);
  await expectNoPageOverflow(page);
  await cell.getByRole('link', { name: title }).click();
  await expect(page).toHaveURL(new RegExp(`/acme/requirements/${req.displayKey}$`));
  await expect(page.getByRole('heading', { level: 1 })).toContainText(title);
});

test('G3：查看者看到中文锁定说明，跟进页同样说明只读', async ({ request, browser }) => {
  await setupInstance(request);
  const productId = await createProduct(request);
  const req = await createRequirement(request, productId, '只读需求');
  await ok(request.post(`/api/v1/orgs/acme/requirements/${req.id}/transitions`, { data: { to: 'doing' } }));
  const ctx = await browser.newContext();
  const viewer = await ctx.newPage();
  const viewerId = await acceptInvite(viewer, request, { email: 'viewer@example.com', orgRole: 'member', name: '只读成员' });
  await ok(request.put(`/api/v1/orgs/acme/products/${productId}/roles/${viewerId}`, { data: { role: 'viewer' } }));
  await viewer.goto(`/acme/requirements/${req.displayKey}`);
  await expect(viewer.getByText('你是查看者，不能修改这条需求')).toBeVisible();
  await expect(viewer.getByText('只有编辑可以改预计上线日期')).toBeVisible();
  await viewer.goto('/acme/tracking');
  await expect(viewer.getByText('你对这些条目没有编辑权限，不能写进展')).toBeVisible();
  await ctx.close();
});

test('G6：已初始化的 /setup 有说明；错用户邀请可以退出', async ({ page, request }) => {
  await setupInstance(request);
  await page.goto('/setup');
  await expect(page.getByRole('heading', { name: '已经初始化' })).toBeVisible();
  await expect(page.getByRole('link', { name: '去登录' })).toHaveAttribute('href', '/login');

  await login(page, OWNER.email, OWNER.password);
  const { token } = await json<{ token: string }>(request.post('/api/v1/orgs/acme/invitations', { data: { email: 'other@example.com', orgRole: 'member' } }));
  await page.goto(`/invite/${token}`);
  await expect(page.getByText('请退出后用受邀邮箱登录')).toBeVisible();
  await page.getByRole('button', { name: '退出登录' }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test('G7：跟进空筛点明当前条件', async ({ page, request }) => {
  await setupInstance(request);
  await createProduct(request);
  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme/tracking?paused=1');
  await expect(page.getByText('当前筛选：只看暂停').first()).toBeVisible();
  await expect(page.getByRole('button', { name: '清除筛选' }).first()).toBeVisible();
});

test('G8：组织名空值有中文校验；邀请写明谁可邀请；个人设置说明保存位置', async ({ page, request }) => {
  await setupInstance(request);
  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme/settings/general');
  await page.getByLabel('组织名称').fill('');
  await expect(page.getByText('请填写组织名称')).toBeVisible();
  await expect(page.getByRole('button', { name: '保存' })).toBeDisabled();

  await page.goto('/acme/settings/members');
  await page.getByRole('button', { name: '邀请成员' }).click();
  await expect(page.getByRole('dialog')).toContainText('只有组织管理员和所有者可以邀请成员');

  await page.goto('/acme/settings/fields');
  await expect(page.getByText('这里不能新建字段')).toBeVisible();
  await expect(page.getByText('单选表示一条需求只能选一个选项')).toBeVisible();

  await page.goto('/settings');
  await expect(page.getByText('外观、姓名和通知偏好在这个个人设置页')).toBeVisible();
  await page.getByLabel('姓名').fill('林澄 Lin');
  await page.getByRole('button', { name: '保存资料' }).click();
  await expect(page.getByRole('status').filter({ hasText: '资料已保存' })).toBeVisible();
});

test('工作台空栏可以点进现有列表', async ({ page, request }) => {
  await setupInstance(request);
  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme');
  await expect(page.getByRole('link', { name: '没有进行中的需求与工作项' })).toHaveAttribute('href', '/acme/requirements');
  await expect(page.getByRole('link', { name: '没有未完成的任务' })).toHaveAttribute('href', '/acme/iterations');
  await expect(page.getByRole('link', { name: '没有未读评论' })).toHaveAttribute('href', '/acme/notifications');
});
