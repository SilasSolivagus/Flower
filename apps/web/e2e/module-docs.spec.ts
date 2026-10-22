import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { acceptInvite, createNode, createProduct, expectNoPageOverflow, json, login, ok, OWNER, setupInstance } from './helpers';

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

test('模块文档详情：所属与合入记录；编辑自动保存；归档后只读、隐藏恢复，恢复为使用中后可编辑；面包屑回到模块文档页签并定位', async ({ page, request }) => {
  const productId = await createProduct(request);
  const storage = await createNode(request, productId, null, '存储');
  const upload = await createNode(request, productId, storage, '上传');
  const mod = (await json<{ document: { id: string; displayKey: string; version: number } }>(request.post(`/api/v1/orgs/acme/nodes/${upload}/module-document`))).document;
  await ok(request.put(`/api/v1/orgs/acme/documents/${mod.id}/content`, { data: { baseVersion: mod.version, markdown: '上传总述\n\n## 分片上传\n\n说明' } }));
  // 同一作者 5 分钟内的保存并入第 1 版；恢复一次得到第 2 版，页面上才有「恢复第 1 版」按钮可检查
  await ok(request.post(`/api/v1/orgs/acme/documents/${mod.id}/restore`, { data: { number: 1, baseVersion: mod.version + 1 } }));
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/documents/${mod.displayKey}`);
  const side = page.getByRole('complementary');
  await expect(side.getByRole('region', { name: '所属' })).toContainText('存储');
  await expect(side.getByRole('region', { name: '所属' })).toContainText('上传');
  await expect(side.getByRole('region', { name: '状态' })).toContainText('使用中');
  await expect(side.getByRole('region', { name: '修订记录' })).toContainText('第 2 版');
  await expect(side.getByRole('button', { name: '恢复第 1 版' })).toBeVisible();
  await expect(side.getByRole('region', { name: '覆盖的需求' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: '合入记录' })).toContainText('还没有合入记录');
  await expect(page.getByRole('region', { name: '被引用' })).toBeVisible();

  const body = page.getByRole('region', { name: '正文' });
  await expect(body).toContainText('分片上传');
  await body.locator('.bn-block-content').last().click();
  await page.keyboard.press('End');
  await page.keyboard.type('，支持断点续传');
  await expect(body.getByRole('status')).toHaveText('已保存');

  const title = page.getByRole('button', { name: new RegExp(`^${mod.displayKey}`) });
  await expect(title).toBeEnabled();
  await side.getByRole('button', { name: '改为已归档' }).click();
  await expect(side.getByRole('region', { name: '状态' })).toContainText('已归档');
  await expect(body.getByRole('status')).toHaveText('只读');
  await expect(side.getByRole('region', { name: '修订记录' })).toContainText('第 1 版');
  await expect(side.getByRole('button', { name: /^恢复第/ })).toHaveCount(0);
  // 已归档：不能改标题，也打不开导入对话框
  await expect(title).toBeDisabled();
  await page.goto(`/acme/documents/${mod.displayKey}?import=1`);
  await expect(body.getByRole('status')).toHaveText('只读');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.goto(`/acme/documents/${mod.displayKey}`);
  await expect(body.getByRole('status')).toHaveText('只读');
  await side.getByRole('button', { name: '改为使用中' }).click();
  await expect(body.getByRole('status')).toHaveText('已保存');
  await page.reload();
  await expect(page.getByRole('region', { name: '正文' })).toContainText('支持断点续传');

  await page.getByRole('navigation', { name: '面包屑' }).getByRole('link', { name: '模块文档', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`view=modules&node=${upload}`));
  await expect(page.getByRole('row', { name: /^上传/ })).toHaveAttribute('aria-current', 'true');

  for (const width of [1440, 760]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/acme/documents/${mod.displayKey}`);
    await expect(page.getByRole('region', { name: '合入记录' })).toBeVisible();
    await expectNoPageOverflow(page);
  }
});
