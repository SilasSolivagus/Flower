import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { acceptInvite, createDocument, createProduct, expectNoPageOverflow, login, ok, OWNER, setupInstance } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

test('新建 Flower 文档与外部 PRD；重复网址报错；列表按来源与状态筛选', async ({ page, request }) => {
  await createProduct(request);
  await login(page, OWNER.email, OWNER.password);
  await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '文档', exact: true }).click();
  await expect(page.getByText('还没有 PRD')).toBeVisible();

  await page.getByRole('button', { name: '新建 PRD' }).click();
  const dialog = page.getByRole('dialog', { name: '新建 PRD' });
  await dialog.getByLabel('标题').fill('上传提速');
  await expect(dialog.getByRole('combobox', { name: '模板' })).toHaveText('变更 PRD（预置）');
  await dialog.getByRole('button', { name: '创建' }).click();
  await page.waitForURL('**/acme/documents/PAN-PRD-1');

  await page.goto('/acme/documents');
  await page.getByRole('button', { name: '新建 PRD' }).click();
  await dialog.getByRole('tab', { name: '外部链接' }).click();
  await dialog.getByLabel('标题').fill('支付改版');
  await dialog.getByLabel('文档网址').fill('https://doc.weixin.qq.com/doc/w3_PAY?scode=abc');
  await dialog.getByRole('button', { name: '创建' }).click();
  await page.waitForURL('**/acme/documents/PAN-PRD-2');

  await page.goto('/acme/documents');
  await page.getByRole('button', { name: '新建 PRD' }).click();
  await dialog.getByRole('tab', { name: '外部链接' }).click();
  await dialog.getByLabel('标题').fill('重复');
  await dialog.getByLabel('文档网址').fill('https://doc.weixin.qq.com/doc/w3_PAY/?scode=xyz');
  await dialog.getByRole('button', { name: '创建' }).click();
  await expect(dialog.getByRole('alert')).toContainText('该网址已对应 PAN-PRD-2');
  await dialog.getByRole('button', { name: '取消' }).click();

  const table = page.getByRole('table');
  await expect(table.getByRole('row')).toHaveCount(3);
  await expect(table.getByRole('row', { name: /PAN-PRD-2/ })).toContainText('企业微信文档');
  await expect(table.getByRole('row', { name: /PAN-PRD-1/ })).toContainText('草稿');
  await page.getByRole('combobox', { name: '来源' }).click();
  await page.getByRole('option', { name: '外部链接' }).click();
  await expect(page).toHaveURL(/source=external/);
  await expect(table.getByRole('row')).toHaveCount(2);
  await page.getByRole('combobox', { name: '状态' }).click();
  await page.getByRole('option', { name: '评审中' }).click();
  await expect(page.getByText('没有符合条件的 PRD')).toBeVisible();
});

test('只读成员看不到新建按钮，可以搜索；1440 与 760 宽度下页面不横向滚动', async ({ browser, request }) => {
  const productId = await createProduct(request);
  await createDocument(request, productId, { title: '一个很长的 PRD 标题，用来检查窄屏下表格不会把页面撑宽，也不会把标题挤没' });
  await createDocument(request, productId, { title: '支付改版', externalUrl: 'https://docs.qq.com/doc/pay' });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const viewerId = await acceptInvite(page, request, { email: 'viewer@example.com', orgRole: 'member', name: '只读成员' });
  await ok(request.put(`/api/v1/orgs/acme/products/${productId}/roles/${viewerId}`, { data: { role: 'viewer' } }));

  await page.goto('/acme/documents');
  await expect(page.getByRole('row', { name: /支付改版/ })).toBeVisible();
  await expect(page.getByRole('button', { name: '新建 PRD' })).toHaveCount(0);
  const search = page.getByRole('searchbox', { name: '搜索 PRD' });
  await search.fill('支付');
  await search.press('Enter');
  await expect(page).toHaveURL(/q=/);
  await expect(page.getByRole('table').getByRole('row')).toHaveCount(2);

  for (const width of [1440, 760]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/acme/documents');
    await expect(page.getByRole('row', { name: /支付改版/ })).toBeVisible();
    await expectNoPageOverflow(page);
  }
  await ctx.close();
});
