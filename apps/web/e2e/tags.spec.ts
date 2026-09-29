import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { login, OWNER, setupInstance } from './helpers';

test('新增、改名、改色、删除职能标签', async ({ page, request }) => {
  await resetDatabase();
  await setupInstance(request);
  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme/settings/tags');
  await expect(page.getByRole('textbox', { name: '标签名称' })).toHaveCount(4);

  await page.getByRole('button', { name: '新增标签' }).click();
  await page.getByLabel('新标签名称').fill('线条负责人');
  await page.getByRole('button', { name: '添加' }).click();
  await expect(page.getByRole('textbox', { name: '标签名称' })).toHaveCount(5);

  const last = page.getByRole('textbox', { name: '标签名称' }).last();
  await last.fill('业务线负责人');
  await last.blur();
  await expect(page.getByText('已保存')).toBeVisible();

  await page.getByRole('button', { name: '删除业务线负责人' }).click();
  await page.getByRole('button', { name: '确认删除' }).click();
  await expect(page.getByRole('textbox', { name: '标签名称' })).toHaveCount(4);
});
