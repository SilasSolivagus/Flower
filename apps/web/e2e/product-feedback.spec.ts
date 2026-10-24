import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { acceptInvite, login, OWNER, setupInstance } from './helpers';

const FORM = 'https://forms.gle/XaEtvkHrRQZePrwL8';

test.describe('Flower 产品反馈', () => {
  test.beforeEach(async () => {
    await resetDatabase();
  });

  test('组织顶栏「反馈」在通知左侧，成员和访客都能在新标签打开表单', async ({ page, request, browser }) => {
    await setupInstance(request);
    await login(page, OWNER.email, OWNER.password);
    await page.waitForURL('**/acme');

    const link = page.getByRole('link', { name: '反馈 Flower 产品' });
    const bell = page.getByRole('button', { name: '通知', exact: true });
    await expect(link).toBeVisible();
    await expect(link).toHaveText('反馈');
    await expect(link).toHaveAttribute('href', FORM);
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');

    const linkBox = await link.boundingBox();
    const bellBox = await bell.boundingBox();
    expect(linkBox).not.toBeNull();
    expect(bellBox).not.toBeNull();
    expect(linkBox!.x + linkBox!.width).toBeLessThanOrEqual(bellBox!.x);

    await page.setViewportSize({ width: 390, height: 800 });
    await expect(link).toBeVisible();
    const narrow = await link.boundingBox();
    expect(narrow).not.toBeNull();
    expect(narrow!.x).toBeGreaterThanOrEqual(0);
    expect(narrow!.x + narrow!.width).toBeLessThanOrEqual(390);

    const ctx = await browser.newContext();
    const guest = await ctx.newPage();
    await acceptInvite(guest, request, { email: 'guest@example.com', orgRole: 'guest', name: '访客' });
    const guestLink = guest.getByRole('link', { name: '反馈 Flower 产品' });
    await expect(guestLink).toBeVisible();
    await expect(guestLink).toHaveAttribute('href', FORM);
    await expect(guestLink).toHaveAttribute('target', '_blank');
    await ctx.close();
  });
});
