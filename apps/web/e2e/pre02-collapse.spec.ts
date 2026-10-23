import { expect, type Locator, test } from '@playwright/test';
import { resetDatabase } from './db';
import { createProduct, createRequirement, expectNoPageOverflow, login, ok, OWNER, setupInstance } from './helpers';

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
  await ok(
    request.patch(`/api/v1/orgs/acme/requirements/${req.id}`, {
      data: { description: Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 段：主列需要长过一屏，用来确认右栏在滚动后仍然贴在视口里。`).join('\n\n') },
    }),
  );
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
  await expect(narrative.getByRole('heading', { name: '描述' })).toBeVisible();
  await expect(narrative.getByRole('tab', { name: '评论' })).toBeVisible();
  await expect(narrative.getByRole('heading', { name: '状态历史' })).toHaveCount(0);
  await expect(aside.getByRole('heading', { name: '跟进' })).toBeVisible();
  await expect(aside.getByRole('heading', { name: '状态历史' })).toBeVisible();
  const asideColumn = page.getByTestId('req-detail-aside-column');
  const asideWidth = await widthOf(asideColumn);
  expect(asideWidth).toBeGreaterThanOrEqual(360);
  expect(asideWidth).toBeLessThanOrEqual(400);
  const trackingBox = await aside.getByRole('region', { name: '跟进' }).boundingBox();
  const statusBox = await aside.getByRole('region', { name: '状态', exact: true }).boundingBox();
  const historyBox = await aside.getByRole('region', { name: '状态历史' }).boundingBox();
  expect(trackingBox!.y).toBeLessThan(statusBox!.y);
  expect(statusBox!.y).toBeLessThan(historyBox!.y);
  expect(trackingBox!.y).toBeLessThan(450);
  await aside.getByRole('heading', { name: '发布版本' }).scrollIntoViewIfNeeded();
  await expect(aside.getByRole('heading', { name: '发布版本' })).toBeVisible();
  await asideColumn.evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.evaluate(() => window.scrollTo(0, 0));
  await narrative.getByRole('tab', { name: '进展记录' }).scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(200);
  const trackingStuck = await aside.getByRole('region', { name: '跟进' }).boundingBox();
  expect(trackingStuck!.y).toBeGreaterThanOrEqual(0);
  expect(trackingStuck!.y).toBeLessThan(160);
  await page.evaluate(() => window.scrollTo(0, 0));
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
  await expect(page.getByRole('region', { name: '状态', exact: true })).toBeHidden();
  await expect(page.getByRole('heading', { name: '跟进' })).toBeHidden();
  await expect(narrative.getByRole('heading', { name: '状态历史' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '状态历史' })).toBeHidden();
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
  await expect(page.getByRole('region', { name: '状态', exact: true })).toBeVisible();
  await expect(narrative.getByRole('heading', { name: '状态历史' })).toHaveCount(0);
  await expect(aside.getByRole('heading', { name: '状态历史' })).toBeVisible();
  const trackingNarrow = await aside.getByRole('region', { name: '跟进' }).boundingBox();
  const statusNarrow = await aside.getByRole('region', { name: '状态', exact: true }).boundingBox();
  expect(trackingNarrow!.y).toBeLessThan(statusNarrow!.y);
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
