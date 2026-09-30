import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { login, OWNER, setupInstance } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

test('产品设置：维护结构树，停用的节点不出现在需求详情的节点下拉中', async ({ page, request }) => {
  const res = await request.post('/api/v1/orgs/acme/products', { data: { name: '网盘', key: 'PAN' } });
  expect(res.ok()).toBeTruthy();
  const productId = (await res.json()).product.id as string;
  expect((await request.post(`/api/v1/orgs/acme/products/${productId}/requirements`, { data: { title: '自动续费提醒' } })).ok()).toBeTruthy();

  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/settings/products/${productId}`);
  await page.getByRole('tab', { name: '结构树' }).click();
  const tree = page.getByRole('region', { name: '结构树' });
  await expect(tree).toContainText('还没有节点');

  await tree.getByRole('button', { name: '新增业务域' }).click();
  await tree.getByLabel('新业务域名称').fill('会员与支付');
  await tree.getByRole('button', { name: '添加' }).click();
  await expect(page.getByText('已新增节点')).toBeVisible();
  await tree.getByRole('button', { name: '在 会员与支付 下新增' }).click();
  await tree.getByLabel('新模块名称').fill('续费');
  await tree.getByRole('button', { name: '添加' }).click();
  await expect(tree).toContainText('续费');
  await tree.getByRole('button', { name: '新增业务域' }).click();
  await tree.getByLabel('新业务域名称').fill('存储');
  await tree.getByRole('button', { name: '添加' }).click();
  await expect(tree).toContainText('存储');

  await tree.getByRole('button', { name: '上移 存储' }).click();
  await expect(tree.getByRole('listitem').first()).toContainText('存储');

  await tree.getByRole('button', { name: '重命名 续费' }).click();
  await tree.getByLabel('节点名称').fill('自动续费');
  await tree.getByRole('button', { name: '保存' }).click();
  await expect(tree).toContainText('自动续费');

  await tree.getByRole('button', { name: '停用 自动续费' }).click();
  await expect(tree).toContainText('自动续费（已停用）');

  await page.goto('/acme/requirements/PAN-1');
  await page.getByRole('combobox', { name: '结构节点' }).click();
  await expect(page.getByRole('option', { name: '会员与支付' })).toBeVisible();
  await expect(page.getByRole('option', { name: '自动续费' })).toHaveCount(0);
});
