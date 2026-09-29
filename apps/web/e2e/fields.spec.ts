import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { login, OWNER, setupInstance } from './helpers';

test('给平台字段加选项、停用选项、设置组织层级叫法', async ({ page, request }) => {
  await resetDatabase();
  await setupInstance(request);
  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme/settings/fields');

  const platform = page.getByRole('region', { name: '平台' });
  await platform.getByLabel('新选项').fill('PC客户端');
  await platform.getByRole('button', { name: '添加' }).click();
  await platform.getByLabel('新选项').fill('Web端');
  await platform.getByRole('button', { name: '添加' }).click();
  await expect(platform.getByRole('textbox', { name: '选项名称' })).toHaveCount(2);

  await platform.getByRole('switch', { name: 'Web端 启用' }).click();
  await expect(platform.getByRole('switch', { name: 'Web端 启用' })).not.toBeChecked();

  await page.getByLabel('第 1 层').fill('产品线');
  await page.getByRole('button', { name: '保存层级叫法' }).click();
  await expect(page.getByText('已保存')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('第 1 层')).toHaveValue('产品线');
});
