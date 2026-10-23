import { expect, type Locator, test } from '@playwright/test';
import { resetDatabase } from './db';
import { createProduct, createRequirement, login, ok, OWNER, setupInstance } from './helpers';

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  expect(box, '元素应有布局').not.toBeNull();
  return box!;
}

/** 跟进顶边落在主列底边之下（PRE-02 把 aside 排到 row2 时为 true）。 */
function trackingBelowMain(tracking: { y: number; height: number }, main: { y: number; height: number }): boolean {
  return tracking.y >= main.y + main.height - 1;
}

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

test('DUX-012：1280 跟进与主列同一行且右轨 380；760 跟进在主列之前', async ({ page, request }) => {
  const productId = await createProduct(request);
  const req = await createRequirement(request, productId, '分享链接支持设置密码');
  await ok(
    request.patch(`/api/v1/orgs/acme/requirements/${req.id}`, {
      data: { description: Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 段说明，用来把主列拉高，确认右轨在滚动后仍停在视口里。`).join('\n\n') },
    }),
  );
  await login(page, OWNER.email, OWNER.password);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/acme/requirements/${req.displayKey}`);

  const rail = page.getByTestId('req-detail-rail');
  const main = page.getByTestId('req-detail-main');
  const tracking = page.getByRole('heading', { name: '跟进' });
  const status = page.getByRole('heading', { name: '状态', exact: true });
  const history = page.getByRole('heading', { name: '状态历史' });

  await expect(tracking).toBeVisible();
  await expect(main.getByRole('heading', { name: '状态历史' })).toHaveCount(0);
  await expect(page.getByTestId('req-detail-aside').getByRole('heading', { name: '状态历史' })).toBeVisible();
  expect(Math.abs((await boxOf(rail)).width - 380)).toBeLessThan(2);

  const trackingBox = await boxOf(tracking);
  const statusBox = await boxOf(status);
  const historyBox = await boxOf(history);
  const mainBox = await boxOf(main);
  expect(trackingBelowMain(trackingBox, mainBox)).toBe(false);
  expect(trackingBox.y).toBeLessThan(statusBox.y);
  expect(statusBox.y).toBeLessThan(historyBox.y);
  expect(trackingBox.y).toBeLessThan(400);

  const sticky = await rail.evaluate((el) => {
    const cs = getComputedStyle(el);
    const handle = el.querySelector('[data-testid="req-aside-collapse"]');
    return {
      position: cs.position,
      overflowY: cs.overflowY,
      top: cs.top,
      handlePosition: handle ? getComputedStyle(handle).position : '',
    };
  });
  expect(sticky.position).toBe('sticky');
  expect(sticky.overflowY).toBe('auto');
  expect(sticky.top).toBe('16px');
  expect(sticky.handlePosition).not.toBe('sticky');

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
  const trackingStuck = await boxOf(tracking);
  const mainScrolled = await boxOf(main);
  expect(trackingStuck.y).toBeGreaterThanOrEqual(0);
  expect(trackingStuck.y).toBeLessThan(80);
  expect(trackingBelowMain(trackingStuck, mainScrolled)).toBe(false);

  await page.setViewportSize({ width: 760, height: 900 });
  const narrowTracking = await boxOf(tracking);
  const narrowStatus = await boxOf(status);
  const narrowHistory = await boxOf(history);
  const narrowMain = await boxOf(main);
  expect(narrowTracking.y).toBeLessThan(narrowStatus.y);
  expect(narrowStatus.y).toBeLessThan(narrowHistory.y);
  expect(narrowHistory.y).toBeLessThan(narrowMain.y);
  expect(trackingBelowMain(narrowTracking, narrowMain)).toBe(false);
  await expect(page.getByRole('button', { name: '收起属性栏' })).toBeHidden();
});
