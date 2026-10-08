import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { applyPrdWorkflow, createProduct, createRequirement, login, OWNER, setupInstance } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

test('需求挂 PRD：从需求新建 PRD；PRD 状态带动「PRD」检查项；PRD 评审签字后需求可以进入开发中', async ({ page, request }) => {
  const productId = await createProduct(request);
  await applyPrdWorkflow(request, productId);
  await createRequirement(request, productId, '分片上传');
  await login(page, OWNER.email, OWNER.password);

  await page.goto('/acme/requirements/PAN-1');
  const card = page.getByRole('region', { name: 'PRD', exact: true });
  await expect(card).toContainText('还没有挂 PRD');
  await card.getByRole('button', { name: '新建 PRD' }).click();
  const dialog = page.getByRole('dialog', { name: '新建 PRD' });
  await expect(dialog.getByLabel('标题')).toHaveValue('分片上传');
  await dialog.getByRole('tab', { name: '外部链接' }).click();
  await dialog.getByLabel('文档网址').fill('https://doc.weixin.qq.com/doc/w3_UP');
  await dialog.getByRole('button', { name: '创建' }).click();
  await page.waitForURL('**/acme/documents/PAN-PRD-1');
  const side = page.getByRole('complementary');
  await expect(side.getByRole('region', { name: '覆盖的需求' })).toContainText('PAN-1');
  await side.getByRole('button', { name: '改为评审中' }).click();
  await expect(side.getByRole('region', { name: '状态' })).toContainText('评审中');

  await page.goto('/acme');
  const sign = page.getByRole('region', { name: /等我签字/ });
  await expect(sign.getByRole('link', { name: /PAN-PRD-1/ })).toHaveAttribute('href', '/acme/documents/PAN-PRD-1');
  await page.goto('/acme/reviews');
  await expect(page.getByRole('region', { name: 'PRD 评审' }).getByRole('row', { name: /PAN-PRD-1/ })).toContainText('待我签');

  await page.goto('/acme/requirements/PAN-1');
  const checks = page.getByRole('region', { name: '检查项', exact: true });
  await expect(checks.getByRole('listitem', { name: 'PRD', exact: true })).toContainText('进行中');
  await expect(checks.getByRole('listitem', { name: 'PRD', exact: true })).toContainText('跟随 PRD');
  await expect(checks.getByRole('combobox', { name: 'PRD状态' })).toHaveCount(0);
  await expect(page.getByRole('list', { name: '可流转到' }).getByRole('button', { name: '开发中' })).toBeDisabled();

  await page.goto('/acme/documents/PAN-PRD-1');
  await page.getByRole('complementary').getByRole('listitem', { name: 'PRD 评审' }).getByRole('button', { name: '通过' }).click();
  await expect(page.getByText('已签字')).toBeVisible();
  await page.getByRole('complementary').getByRole('button', { name: '改为已通过' }).click();
  await expect(page.getByRole('complementary').getByRole('region', { name: '状态' })).toContainText('已通过');

  await page.goto('/acme/requirements/PAN-1');
  await expect(page.getByRole('region', { name: '检查项', exact: true }).getByRole('listitem', { name: 'PRD', exact: true })).toContainText('通过');
  await expect(page.getByRole('region', { name: 'PRD 检查项' }).getByRole('listitem', { name: 'PRD 评审' })).toContainText('通过');
  await page.getByRole('list', { name: '可流转到' }).getByRole('button', { name: '开发中' }).click();
  await expect(page.getByTestId('current-state')).toHaveText('开发中');
});
