import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { acceptInvite, createDocument, createNode, createProduct, expectNoPageOverflow, launchDocument, login, ok, OWNER, setupInstance } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

const PRD_BODY = '## 背景\n\n现状\n\n## 需求说明\n\n上传改为分片\n\n### 细节\n\n断点续传';

test('声明影响：当场新建模块与功能点，选变更类型与来源小节；修改、移除；只读成员只能看', async ({ page, browser, request }) => {
  const productId = await createProduct(request);
  await createNode(request, productId, null, '存储');
  const prd = await createDocument(request, productId, { title: '上传改版' });
  await ok(request.put(`/api/v1/orgs/acme/documents/${prd.id}/content`, { data: { baseVersion: prd.version, markdown: PRD_BODY } }));
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/documents/${prd.displayKey}`);
  const card = page.getByRole('complementary').getByRole('region', { name: '影响的功能点' });
  await expect(card).toContainText('还没有声明影响的功能点');

  await card.getByRole('button', { name: '声明影响' }).click();
  const dialog = page.getByRole('dialog', { name: '声明影响' });
  await expect(dialog).toContainText('没有可选的功能点');
  await dialog.getByRole('combobox', { name: '所属业务域' }).click();
  await page.getByRole('option', { name: '存储' }).click();
  await dialog.getByLabel('新模块名称').fill('上传');
  await dialog.getByRole('button', { name: '新建模块' }).click();
  await expect(dialog.getByRole('combobox', { name: '所属模块' })).toHaveText('存储/上传');
  await dialog.getByLabel('新功能点名称').fill('分片上传');
  await dialog.getByRole('button', { name: '新建功能点' }).click();
  await expect(dialog.getByRole('button', { name: '存储/上传/分片上传' })).toHaveAttribute('aria-pressed', 'true');
  await dialog.getByRole('combobox', { name: '变更类型' }).click();
  await page.getByRole('option', { name: '新增' }).click();
  await dialog.getByRole('checkbox', { name: '需求说明', exact: true }).check();
  await dialog.getByRole('button', { name: '保存' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(card).toContainText('存储/上传/分片上传');
  await expect(card).toContainText('新增');
  await expect(card).toContainText('来源：需求说明');

  await card.getByRole('button', { name: '修改 存储/上传/分片上传' }).click();
  const edit = page.getByRole('dialog', { name: '修改影响声明' });
  await edit.getByRole('combobox', { name: '变更类型' }).click();
  await page.getByRole('option', { name: '修改' }).click();
  await edit.getByRole('checkbox', { name: '需求说明 / 细节' }).check();
  await edit.getByRole('button', { name: '保存' }).click();
  await expect(card).toContainText('来源：需求说明、需求说明 / 细节');

  const ctx = await browser.newContext();
  const viewerPage = await ctx.newPage();
  const viewerId = await acceptInvite(viewerPage, request, { email: 'viewer@example.com', orgRole: 'member', name: '只读成员' });
  await ok(request.put(`/api/v1/orgs/acme/products/${productId}/roles/${viewerId}`, { data: { role: 'viewer' } }));
  await viewerPage.goto(`/acme/documents/${prd.displayKey}`);
  const viewerCard = viewerPage.getByRole('complementary').getByRole('region', { name: '影响的功能点' });
  await expect(viewerCard).toContainText('存储/上传/分片上传');
  await expect(viewerCard.getByRole('button')).toHaveCount(0);
  await ctx.close();

  await card.getByRole('button', { name: '移除 存储/上传/分片上传' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '移除' }).click();
  await expect(card).toContainText('还没有声明影响的功能点');

  for (const width of [1440, 760]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/acme/documents/${prd.displayKey}`);
    await page.getByRole('complementary').getByRole('region', { name: '影响的功能点' }).getByRole('button', { name: '声明影响' }).click();
    await expect(page.getByRole('dialog', { name: '声明影响' })).toBeVisible();
    await expect(page.getByRole('dialog', { name: '声明影响' }).getByRole('button', { name: '存储/上传/分片上传' })).toBeVisible();
    await expectNoPageOverflow(page);
    await page.keyboard.press('Escape');
  }
});

test('外部 PRD 不能选来源小节；开始合入后声明锁定，显示合入入口', async ({ page, request }) => {
  const productId = await createProduct(request);
  const storage = await createNode(request, productId, null, '存储');
  const upload = await createNode(request, productId, storage, '上传');
  const chunk = await createNode(request, productId, upload, '分片上传');
  const instant = await createNode(request, productId, upload, '秒传');
  const ext = await createDocument(request, productId, { title: '外部', externalUrl: 'https://docs.qq.com/doc/affected-e2e' });
  const prd = await createDocument(request, productId, { title: '上传改版' });
  await ok(request.post(`/api/v1/orgs/acme/documents/${prd.id}/affected-nodes`, { data: { nodeId: chunk, changeType: 'added' } }));
  await ok(request.post(`/api/v1/orgs/acme/documents/${prd.id}/affected-nodes`, { data: { nodeId: instant, changeType: 'modified' } }));
  await launchDocument(request, prd.id);
  await ok(request.post(`/api/v1/orgs/acme/documents/${prd.id}/merge/${chunk}/skip`));
  await login(page, OWNER.email, OWNER.password);

  await page.goto(`/acme/documents/${ext.displayKey}`);
  await page.getByRole('complementary').getByRole('region', { name: '影响的功能点' }).getByRole('button', { name: '声明影响' }).click();
  await expect(page.getByRole('dialog', { name: '声明影响' })).toContainText('外部 PRD 没有正文，来源小节不可选');
  await page.keyboard.press('Escape');

  await page.goto(`/acme/documents/${prd.displayKey}`);
  const card = page.getByRole('complementary').getByRole('region', { name: '影响的功能点' });
  await expect(card).toContainText('已开始合入，声明在合入页处理。');
  await expect(card).toContainText('已跳过');
  await expect(card.getByRole('button', { name: '声明影响' })).toHaveCount(0);
  await expect(card.getByRole('button', { name: /^修改 / })).toHaveCount(0);
  await expect(card.getByRole('link', { name: '合入模块文档' })).toHaveAttribute('href', `/acme/documents/${prd.displayKey}/merge`);
});
