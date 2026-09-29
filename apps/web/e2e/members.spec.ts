import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { login, OWNER, setupInstance } from './helpers';

test.beforeEach(async ({ page, request }) => {
  await resetDatabase();
  await setupInstance(request);
  await request.post('/api/v1/orgs/acme/products', { data: { name: '网盘', key: 'PAN' } });
  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme/settings/members');
});

test('登记无账号成员，在抽屉中设置部门、职能标签与产品角色', async ({ page }) => {
  await page.getByRole('button', { name: '登记无账号成员' }).click();
  await page.getByLabel('显示名称').fill('王总');
  await page.getByLabel('部门').fill('商务部');
  await page.getByRole('button', { name: '登记' }).click();
  const row = page.getByRole('row', { name: /王总/ });
  await expect(row.getByText('无账号')).toBeVisible();

  await row.getByRole('button', { name: '查看王总' }).click();
  const drawer = page.getByRole('dialog', { name: '王总' });
  await drawer.getByRole('checkbox', { name: '产品经理' }).check();
  await drawer.getByLabel('网盘 的产品角色').click();
  await page.getByRole('option', { name: '只读' }).click();
  await drawer.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText('已保存')).toBeVisible();
  await expect(row.getByText('产品经理')).toBeVisible();
});

test('邀请成员后在"待接受邀请"里复制链接与撤销；搜索与筛选', async ({ page }) => {
  await page.getByRole('button', { name: '邀请成员' }).click();
  await page.getByLabel('邮箱').fill('dev@example.com');
  await page.getByRole('button', { name: '发送邀请' }).click();
  await expect(page.getByLabel('邀请链接')).toHaveValue(/\/invite\//);
  await page.getByRole('button', { name: '完成' }).click();

  await page.getByRole('tab', { name: /待接受邀请/ }).click();
  const inv = page.getByRole('row', { name: /dev@example.com/ });
  await expect(inv.getByText('待接受')).toBeVisible();
  await inv.getByRole('button', { name: '撤销' }).click();
  await page.getByRole('button', { name: '确认撤销' }).click();
  await expect(inv.getByText('已撤销')).toBeVisible();

  await page.getByRole('tab', { name: /^成员/ }).click();
  await page.getByPlaceholder('搜索姓名、邮箱或部门').fill('owner');
  await expect(page.getByRole('row')).toHaveCount(2);
});
