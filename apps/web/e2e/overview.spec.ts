import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { expectNoPageOverflow, login, OWNER, setupInstance } from './helpers';

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

test('概览：760 下产品名与角色不重叠，1280 下仍是三列', async ({ page, request }) => {
  await setupInstance(request);
  for (const product of [
    { name: '验收产品', key: 'ACC' },
    { name: '网盘', key: 'PAN' },
    { name: '相册', key: 'PIC' },
  ]) {
    await request.post('/api/v1/orgs/acme/products', { data: product });
  }
  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme/overview');
  const card = page.getByRole('link', { name: /验收产品/ });
  const name = card.getByText('验收产品', { exact: true });
  const role = card.getByText('管理员', { exact: true });

  await page.setViewportSize({ width: 760, height: 900 });
  await expect(name).toBeVisible();
  await expect(role).toBeVisible();
  const narrow = { name: (await name.boundingBox())!, role: (await role.boundingBox())! };
  const overlaps =
    narrow.name.x < narrow.role.x + narrow.role.width &&
    narrow.name.x + narrow.name.width > narrow.role.x &&
    narrow.name.y < narrow.role.y + narrow.role.height &&
    narrow.name.y + narrow.name.height > narrow.role.y;
  expect(overlaps).toBe(false);
  await expectNoPageOverflow(page);
  await card.click();
  await expect(page).toHaveURL(/\/acme\/requirements\?product=ACC/);

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/acme/overview');
  const boxes = await Promise.all(
    ['验收产品', '网盘', '相册'].map(async (label) => (await page.getByRole('link', { name: new RegExp(label) }).boundingBox())!),
  );
  expect(Math.abs(boxes[0]!.y - boxes[1]!.y)).toBeLessThan(2);
  expect(Math.abs(boxes[1]!.y - boxes[2]!.y)).toBeLessThan(2);
  expect(boxes[1]!.x).toBeGreaterThan(boxes[0]!.x);
  expect(boxes[2]!.x).toBeGreaterThan(boxes[1]!.x);
  const wideName = (await page.getByRole('link', { name: /验收产品/ }).getByText('验收产品', { exact: true }).boundingBox())!;
  const wideRole = (await page.getByRole('link', { name: /验收产品/ }).getByText('管理员', { exact: true }).boundingBox())!;
  expect(wideName.x + wideName.width).toBeLessThanOrEqual(wideRole.x + 1);
  expect(Math.abs(wideName.y + wideName.height / 2 - (wideRole.y + wideRole.height / 2))).toBeLessThan(4);
  await expectNoPageOverflow(page);
});
