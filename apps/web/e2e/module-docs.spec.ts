import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { acceptInvite, createNode, createProduct, expectNoPageOverflow, login, ok, OWNER, setupInstance } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

test('模块文档页签：按业务域列出模块；点击没有文档的模块即新建并打开；结构树页签显示模块文档链接并能定位', async ({ page, request }) => {
  const productId = await createProduct(request);
  const storage = await createNode(request, productId, null, '存储');
  const upload = await createNode(request, productId, storage, '上传');
  const download = await createNode(request, productId, storage, '下载');
  await createNode(request, productId, upload, '分片上传');
  await createNode(request, productId, null, '会员');
  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme/documents');
  await page.getByRole('tab', { name: '模块文档' }).click();
  await expect(page).toHaveURL(/view=modules/);
  const table = page.getByRole('table');
  await expect(table.getByRole('row', { name: '存储' })).toBeVisible();
  await expect(table.getByRole('row', { name: '会员' })).toBeVisible();
  await expect(table).toContainText('还没有模块');
  const row = table.getByRole('row', { name: /^上传/ });
  await expect(row).toContainText('未建');
  await expect(row).toContainText('1');
  await row.getByRole('button', { name: '上传' }).click();
  await expect(page).toHaveURL(/\/acme\/documents\/PAN-PRD-1$/);
  await expect(page.getByRole('region', { name: '正文' }).getByRole('status')).toHaveText('已保存');

  await page.goto(`/acme/settings/products/${productId}`);
  await page.getByRole('tab', { name: '结构树' }).click();
  const tree = page.getByRole('region', { name: '结构树' });
  await expect(tree.getByRole('link', { name: '上传 的模块文档' })).toHaveText('PAN-PRD-1');
  await tree.getByRole('link', { name: '下载 的模块文档' }).click();
  await expect(page).toHaveURL(new RegExp(`view=modules&node=${download}`));
  await expect(page.getByRole('row', { name: /^下载/ })).toHaveAttribute('aria-current', 'true');
  await page.getByRole('tab', { name: '变更 PRD' }).click();
  await expect(page.getByRole('button', { name: '新建 PRD' })).toBeVisible();
});

test('只读成员看得到模块文档页签，但不能新建；两种宽度下不横向滚动', async ({ browser, request }) => {
  const productId = await createProduct(request);
  const storage = await createNode(request, productId, null, '存储');
  await createNode(request, productId, storage, '上传');
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const viewerId = await acceptInvite(page, request, { email: 'viewer@example.com', orgRole: 'member', name: '只读成员' });
  await ok(request.put(`/api/v1/orgs/acme/products/${productId}/roles/${viewerId}`, { data: { role: 'viewer' } }));
  for (const width of [1440, 760]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/acme/documents?product=PAN&view=modules');
    const row = page.getByRole('row', { name: /^上传/ });
    await expect(row).toContainText('未建');
    await expect(row.getByRole('button')).toHaveCount(0);
    await expectNoPageOverflow(page);
  }
  await ctx.close();
});
