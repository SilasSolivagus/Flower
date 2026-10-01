import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { createMember, createProduct, createRequirement, login, OWNER, setupInstance } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

test('需求详情：负责人与提出人可以搜索，回车与方向键选择，选「不填」清空', async ({ page, request }) => {
  const productId = await createProduct(request);
  const req = await createRequirement(request, productId, '上传提速');
  for (let i = 1; i <= 30; i++) await createMember(request, `成员${String(i).padStart(2, '0')}`);
  await createMember(request, '设计师甲');

  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/requirements/${req.displayKey}`);
  const panel = page.getByRole('region', { name: '属性' });
  const owner = panel.getByRole('combobox', { name: '负责人', exact: true });
  await owner.click();
  const search = page.getByRole('textbox', { name: '搜索负责人' });
  await expect(search).toBeFocused();
  await search.fill('设计');
  await expect(page.getByRole('option')).toHaveCount(1);
  const saved = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().includes(`/requirements/${req.id}`));
  await search.press('Enter');
  expect((await saved).ok()).toBeTruthy();
  await expect(owner).toHaveText('设计师甲');

  await owner.click();
  await page.getByRole('option', { name: '不填' }).click();
  await expect(owner).toHaveText('不填');

  const requester = panel.getByRole('combobox', { name: '提出人', exact: true });
  await requester.click();
  await page.getByRole('textbox', { name: '搜索提出人' }).fill('成员0');
  await expect(page.getByRole('option')).toHaveCount(9);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(requester).toHaveText('成员02');
  await page.reload();
  await expect(page.getByRole('region', { name: '属性' }).getByRole('combobox', { name: '提出人', exact: true })).toHaveText('成员02');
});

test('新建需求与阻塞项：提出人、阻塞项负责人用搜索选择', async ({ page, request }) => {
  const productId = await createProduct(request);
  const req = await createRequirement(request, productId, '上传提速');
  for (let i = 1; i <= 12; i++) await createMember(request, `成员${String(i).padStart(2, '0')}`);
  await createMember(request, '客户甲');

  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/requirements/${req.displayKey}`);
  const blockers = page.getByRole('region', { name: '阻塞项' });
  await blockers.getByLabel('新阻塞项').fill('等待支付接口');
  await blockers.getByRole('combobox', { name: '阻塞项负责人' }).click();
  await page.getByRole('textbox', { name: '搜索阻塞项负责人' }).fill('成员12');
  await page.getByRole('option', { name: '成员12' }).click();
  await blockers.getByRole('button', { name: '添加' }).click();
  await expect(page.getByText('已添加阻塞项')).toBeVisible();
  const blockerItem = blockers.getByRole('listitem').filter({ hasText: '等待支付接口' });
  await expect(blockerItem).toContainText('成员12');

  await page.goto('/acme/requirements');
  await page.getByRole('button', { name: '新建需求' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('标题').fill('客户反馈的需求');
  await dialog.getByRole('combobox', { name: '提出人' }).click();
  const listbox = page.getByRole('listbox', { name: '提出人' });
  await expect(listbox).toBeVisible();
  await listbox.hover();
  await page.mouse.wheel(0, 200);
  await expect.poll(() => listbox.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await page.getByRole('textbox', { name: '搜索提出人' }).fill('客户');
  await page.getByRole('option', { name: '客户甲' }).click();
  await expect(dialog.getByRole('combobox', { name: '提出人' })).toHaveText('客户甲');
  await dialog.getByRole('button', { name: '创建' }).click();
  await expect(page.getByText('已创建 PAN-2')).toBeVisible();
  await page.goto('/acme/requirements/PAN-2');
  await expect(page.getByRole('region', { name: '属性' }).getByRole('combobox', { name: '提出人', exact: true })).toHaveText('客户甲');
});
