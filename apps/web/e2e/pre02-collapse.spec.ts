import { expect, type Locator, test } from '@playwright/test';
import { resetDatabase } from './db';
import { createProduct, createRequirement, expectNoPageOverflow, login, OWNER, setupInstance } from './helpers';

async function widthOf(locator: Locator): Promise<number> {
  const box = await locator.boundingBox();
  expect(box, '元素应有布局').not.toBeNull();
  return box!.width;
}

async function labelClipped(locator: Locator): Promise<boolean> {
  return locator.evaluate((el) => getComputedStyle(el).position === 'absolute');
}

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

test('PRE-02：1280 收起左轨和右栏后中间变宽并记住；760 汉堡和单列不回退', async ({ page, request }) => {
  const productId = await createProduct(request);
  const req = await createRequirement(request, productId, '分享链接支持设置密码');
  await login(page, OWNER.email, OWNER.password);

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/acme/requirements/${req.displayKey}`);

  const nav = page.getByRole('navigation', { name: '主导航' });
  const shellMain = page.locator('main');
  const narrative = page.getByTestId('req-detail-main');
  const aside = page.getByTestId('req-detail-aside');

  await expect(page.getByRole('button', { name: '打开导航' })).toBeHidden();
  await expect(nav).toBeVisible();
  await expect(nav).toHaveAttribute('data-collapsed', 'false');
  const navExpanded = await widthOf(nav);
  expect(navExpanded).toBeGreaterThan(200);
  expect(navExpanded).toBeLessThan(280);
  await expect(nav.getByRole('link', { name: '需求', exact: true })).toBeVisible();
  await expect(aside).toBeVisible();
  await expect(page.getByRole('heading', { name: '跟进' })).toBeVisible();
  await expect(aside.getByRole('heading', { name: '状态历史' })).toBeVisible();
  await expect(narrative.getByRole('heading', { name: '状态历史' })).toHaveCount(0);
  expect(Math.abs((await widthOf(page.getByTestId('req-detail-rail'))) - 380)).toBeLessThan(2);
  const mainExpanded = await widthOf(shellMain);
  const narrativeExpanded = await widthOf(narrative);

  await page.getByRole('button', { name: '收起侧栏' }).click();
  await expect(nav).toHaveAttribute('data-collapsed', 'true');
  await expect.poll(() => widthOf(nav)).toBeLessThan(80);
  const navRail = await widthOf(nav);
  expect(navRail).toBeGreaterThan(40);
  const mainAfterNav = await widthOf(shellMain);
  expect(mainAfterNav - mainExpanded).toBeGreaterThan(150);
  await expect(nav.getByRole('link', { name: '需求', exact: true })).toBeVisible();
  const railLabel = nav.getByRole('link', { name: '需求', exact: true }).getByText('需求');
  expect(await labelClipped(railLabel)).toBe(true);

  await page.getByRole('button', { name: '收起属性栏' }).click();
  await expect(page.getByTestId('req-detail-grid')).toHaveAttribute('data-aside-collapsed', 'true');
  await expect(aside).toBeHidden();
  await expect(page.getByRole('heading', { name: '状态', exact: true })).toBeHidden();
  await expect(page.getByRole('heading', { name: '跟进' })).toBeHidden();
  await expect(narrative.getByRole('heading', { name: '状态历史' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '状态历史' })).toBeHidden();
  expect(await widthOf(page.getByTestId('req-detail-rail'))).toBeLessThan(48);
  await expect(page.getByRole('button', { name: '展开属性栏' })).toBeVisible();
  const narrativeBoth = await widthOf(narrative);
  expect(narrativeBoth - narrativeExpanded).toBeGreaterThan(400);
  const handle = await widthOf(page.getByTestId('req-aside-collapse'));
  expect(handle).toBeLessThan(48);
  await expectNoPageOverflow(page);

  await page.reload();
  await expect(nav).toHaveAttribute('data-collapsed', 'true');
  await expect.poll(() => widthOf(nav)).toBeLessThan(80);
  await expect(page.getByTestId('req-detail-grid')).toHaveAttribute('data-aside-collapsed', 'true');
  await expect(aside).toBeHidden();
  await expect(narrative.getByRole('heading', { name: '状态历史' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '状态历史' })).toBeHidden();

  await page.getByRole('button', { name: '展开侧栏' }).click();
  await page.getByRole('button', { name: '展开属性栏' }).click();
  await expect(nav).toHaveAttribute('data-collapsed', 'false');
  await expect.poll(() => widthOf(nav)).toBeGreaterThan(200);
  await expect(aside).toBeVisible();
  await expect(page.getByRole('heading', { name: '跟进' })).toBeVisible();

  await page.evaluate(() => {
    localStorage.setItem('flower.shell.navCollapsed', '1');
    localStorage.setItem('flower.req.detail.asideCollapsed', '1');
  });
  await page.setViewportSize({ width: 760, height: 900 });
  await page.reload();

  await expect(nav).toBeHidden();
  await expect(page.getByRole('button', { name: '打开导航' })).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('button', { name: '收起侧栏' })).toBeHidden();
  await expect(page.getByRole('button', { name: '展开属性栏' })).toBeHidden();
  await expect(page.getByRole('heading', { name: '跟进' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '状态', exact: true })).toBeVisible();
  await expect(narrative.getByRole('heading', { name: '状态历史' })).toHaveCount(0);
  await expect(aside.getByRole('heading', { name: '状态历史' })).toBeVisible();
  await expectNoPageOverflow(page);

  await page.getByRole('button', { name: '打开导航' }).click();
  await expect(nav).toBeVisible();
  const drawer = await widthOf(nav);
  expect(drawer).toBeGreaterThan(200);
  expect(drawer).toBeLessThan(280);
  const drawerLabel = nav.getByRole('link', { name: '需求', exact: true }).getByText('需求');
  await expect(drawerLabel).toBeVisible();
  expect(await labelClipped(drawerLabel)).toBe(false);
  expect((await drawerLabel.boundingBox())!.width).toBeGreaterThan(20);
  expect((await shellMain.boundingBox())!.x).toBeLessThan(40);

  await page.keyboard.press('Escape');
  await expect(nav).toBeHidden();
  await page.getByRole('button', { name: '打开导航' }).click();
  await page.getByRole('button', { name: '关闭导航' }).click();
  await expect(nav).toBeHidden();
  await page.getByRole('button', { name: '打开导航' }).click();
  await page.getByRole('button', { name: '收起导航' }).click();
  await expect(nav).toBeHidden();

  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.getByRole('button', { name: '打开导航' })).toBeHidden();
  await expect.poll(() => widthOf(nav)).toBeLessThan(80);
  await expect(aside).toBeHidden();
  await expect(page.getByRole('button', { name: '展开属性栏' })).toBeVisible();
});
