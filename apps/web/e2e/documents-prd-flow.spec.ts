import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { applyPrdWorkflow, createDocument, createProduct, createRequirement, login, OWNER, setupInstance } from './helpers';

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
  // 「状态」区域里本来就有「改为评审中」按钮，只查文字会立刻通过；等按钮消失，说明流转已提交并刷新
  await expect(side.getByRole('button', { name: '改为评审中' })).toHaveCount(0);
  await expect(side.getByRole('region', { name: '状态' })).toContainText('评审中');

  await page.goto('/acme');
  const sign = page.getByRole('region', { name: /等我签字/ });
  const signatureLink = sign.getByRole('link', { name: /PAN-PRD-1/ });
  await expect(signatureLink).toBeVisible({ timeout: 15_000 });
  await signatureLink.click();
  await page.waitForURL('**/acme/documents/PAN-PRD-1');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('分片上传');
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
  await expect(page.getByRole('complementary').getByRole('button', { name: '改为已通过' })).toHaveCount(0);
  await expect(page.getByRole('complementary').getByRole('region', { name: '状态' })).toContainText('已通过');

  await page.goto('/acme/requirements/PAN-1');
  await expect(page.getByRole('region', { name: '检查项', exact: true }).getByRole('listitem', { name: 'PRD', exact: true })).toContainText('通过');
  await expect(page.getByRole('region', { name: 'PRD 检查项' }).getByRole('listitem', { name: 'PRD 评审' })).toContainText('通过');
  await page.getByRole('list', { name: '可流转到' }).getByRole('button', { name: '开发中' }).click();
  await expect(page.getByTestId('current-state')).toHaveText('开发中');
});

test('需求已经挂在一份 PRD 上时，尝试把它关联到另一份 PRD 显示冲突提示', async ({ page, request }) => {
  const productId = await createProduct(request);
  const req = await createRequirement(request, productId, '分片上传');
  // 新建时直接带上 requirementIds，相当于「新建 PRD」从需求详情挂上第一份 PRD
  await createDocument(request, productId, { title: 'PRD 甲', externalUrl: 'https://doc.weixin.qq.com/doc/w3_A', requirementIds: [req.id] });
  const other = await createDocument(request, productId, { title: 'PRD 乙', externalUrl: 'https://doc.weixin.qq.com/doc/w3_B' });
  await login(page, OWNER.email, OWNER.password);

  await page.goto(`/acme/documents/${other.displayKey}`);
  const side = page.getByRole('complementary');
  await side.getByRole('region', { name: '覆盖的需求' }).getByLabel('需求编号').fill(req.displayKey);
  await side.getByRole('button', { name: '关联' }).click();
  await expect(side.getByText(`${req.displayKey} 已挂在 PAN-PRD-1 上，请先从那份 PRD 移出`)).toBeVisible();
});
