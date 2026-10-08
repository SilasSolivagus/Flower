import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { acceptInvite, createDocument, createProduct, json, login, ok, OWNER, PNG_1PX_BASE64, presetTemplateId, readToken, setupInstance } from './helpers';

const PNG = Buffer.from(PNG_1PX_BASE64, 'base64');

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

test('只读成员：能看、能评论，不能改正文、状态、覆盖需求、恢复版本、转换外部 PRD', async ({ browser, request }) => {
  const productId = await createProduct(request);
  const native = await createDocument(request, productId, { title: '原生', templateId: await presetTemplateId(request, productId) });
  await ok(request.put(`/api/v1/orgs/acme/documents/${native.id}/content`, { data: { baseVersion: 1, markdown: '## 背景\n\n第一稿' } }));
  const external = await createDocument(request, productId, { title: '外部', externalUrl: 'https://docs.qq.com/doc/ro' });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const viewerId = await acceptInvite(page, request, { email: 'viewer@example.com', orgRole: 'member', name: '只读成员' });
  await ok(request.put(`/api/v1/orgs/acme/products/${productId}/roles/${viewerId}`, { data: { role: 'viewer' } }));

  await page.goto(`/acme/documents/${native.displayKey}`);
  const side = page.getByRole('complementary');
  await expect(side.getByRole('region', { name: '修订记录' })).toContainText('第 1 版');
  await expect(side.getByRole('button', { name: /^改为/ })).toHaveCount(0);
  await expect(side.getByRole('button', { name: '关联' })).toHaveCount(0);
  await expect(side.getByRole('button', { name: /^恢复第/ })).toHaveCount(0);
  const comments = page.getByRole('region', { name: '评论' });
  await comments.getByLabel('发表评论').fill('只读成员也能提意见');
  await comments.getByRole('button', { name: '发表' }).click();
  await expect(comments).toContainText('只读成员也能提意见');

  await page.goto(`/acme/documents/${external.displayKey}`);
  await expect(page.getByRole('region', { name: '外部文档' })).toContainText('腾讯文档');
  await expect(page.getByRole('button', { name: '转为 Flower 文档' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '修改链接' })).toHaveCount(0);
  await ctx.close();
});

test('只读 Token：能读 PRD、修订与评论；不能新建、保存、改状态、评论、上传', async ({ request, playwright }) => {
  const productId = await createProduct(request);
  const doc = await createDocument(request, productId, { title: '接口', templateId: await presetTemplateId(request, productId) });
  const token = await readToken(request);
  const api = await playwright.request.newContext({ baseURL: 'http://localhost:3100', extraHTTPHeaders: { authorization: `Bearer ${token}` } });
  expect((await api.get(`/api/v1/orgs/acme/documents/${doc.displayKey}`)).status()).toBe(200);
  expect((await api.get(`/api/v1/orgs/acme/documents/${doc.id}/revisions`)).status()).toBe(200);
  expect((await api.get(`/api/v1/orgs/acme/documents/${doc.id}/comments`)).status()).toBe(200);
  expect((await api.post(`/api/v1/orgs/acme/products/${productId}/documents`, { data: { title: 'x' } })).status()).toBe(403);
  expect((await api.put(`/api/v1/orgs/acme/documents/${doc.id}/content`, { data: { baseVersion: 1, markdown: 'x' } })).status()).toBe(403);
  expect((await api.post(`/api/v1/orgs/acme/documents/${doc.id}/transitions`, { data: { to: 'review' } })).status()).toBe(403);
  expect((await api.post(`/api/v1/orgs/acme/documents/${doc.id}/comments`, { data: { body: 'x' } })).status()).toBe(403);
  expect((await api.post(`/api/v1/orgs/acme/documents/${doc.id}/attachments`, { multipart: { file: { name: 'a.png', mimeType: 'image/png', buffer: PNG } } })).status()).toBe(403);
  await api.dispose();
});

test('文档模板：组织管理员维护模板与必填小节，提交评审时检查；普通成员进不了设置页；产品管理员在产品设置里覆盖', async ({ page, browser, request }) => {
  const productId = await createProduct(request);
  await login(page, OWNER.email, OWNER.password);
  await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '文档模板' }).click();
  await expect(page.getByRole('row', { name: /变更 PRD（预置）/ })).toContainText('1. 背景介绍、3. 需求说明');

  await page.getByRole('button', { name: '新建模板' }).click();
  const dialog = page.getByRole('dialog', { name: '新建模板' });
  await dialog.getByLabel('模板名称').fill('轻量 PRD');
  await dialog.getByLabel('模板正文').fill('## 背景\n\n待填\n\n## 方案\n\n待填\n');
  await dialog.getByRole('button', { name: '从正文提取小节' }).click();
  await expect(dialog.getByLabel('小节 2 标题')).toHaveValue('方案');
  await dialog.getByRole('checkbox', { name: '小节 1 必填' }).click();
  await dialog.getByRole('button', { name: '保存模板' }).click();
  await expect(page.getByRole('row', { name: /轻量 PRD/ })).toContainText('背景');

  const templates = (await json<{ templates: Array<{ id: string; name: string }> }>(request.get(`/api/v1/orgs/acme/templates?product=${productId}&usable=1`))).templates;
  const doc = await createDocument(request, productId, { title: '缺小节', templateId: templates.find((t) => t.name === '轻量 PRD')!.id });
  await page.goto(`/acme/documents/${doc.displayKey}`);
  await page.getByRole('complementary').getByRole('button', { name: '改为评审中' }).click();
  await expect(page.getByRole('complementary').getByRole('alert')).toContainText('以下必填小节未填写：背景');

  const ctx = await browser.newContext();
  const member = await ctx.newPage();
  const memberId = await acceptInvite(member, request, { email: 'pm@example.com', orgRole: 'member', name: '产品管理员乙' });
  await member.goto('/acme/settings/templates');
  await expect(member.getByRole('heading', { name: '无权访问' })).toBeVisible();
  await ok(request.put(`/api/v1/orgs/acme/products/${productId}/roles/${memberId}`, { data: { role: 'admin' } }));
  await member.goto(`/acme/settings/products/${productId}`);
  await member.getByRole('tab', { name: '文档模板' }).click();
  await member.getByRole('button', { name: '新建模板' }).click();
  const productDialog = member.getByRole('dialog', { name: '新建模板' });
  await productDialog.getByLabel('模板名称').fill('轻量 PRD');
  await productDialog.getByLabel('模板正文').fill('## 背景\n\n产品版\n');
  await productDialog.getByRole('button', { name: '保存模板' }).click();
  await expect(member.getByRole('tabpanel').getByRole('row', { name: /轻量 PRD/ })).toBeVisible();
  await ctx.close();
});
