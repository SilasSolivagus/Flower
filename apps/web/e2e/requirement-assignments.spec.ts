import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { acceptInvite, createMember, createProduct, createRequirement, json, login, ok, OWNER, setupInstance } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

test('需求详情：新增与删除分配，重复时在表单里提示', async ({ page, request }) => {
  const productId = await createProduct(request);
  const req = await createRequirement(request, productId, '上传提速');
  await createMember(request, '设计师甲');

  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/requirements/${req.displayKey}`);
  const section = page.getByRole('region', { name: '分配', exact: true });
  await expect(section).toContainText('还没有分配');

  const pick = async (combobox: string, option: string) => {
    await section.getByRole('combobox', { name: combobox }).click();
    await page.getByRole('option', { name: option }).click();
  };
  await pick('分配职能', '设计');
  await pick('分配成员', '设计师甲');
  await section.getByRole('button', { name: '添加分配' }).click();
  await expect(page.getByText('已添加分配')).toBeVisible();
  await expect(section).toContainText('设计师甲 · 设计');

  await pick('分配成员', '设计师甲');
  await section.getByRole('button', { name: '添加分配' }).click();
  await expect(section.getByRole('alert').filter({ hasText: '已经有相同的分配' })).toBeVisible();

  await section.getByRole('button', { name: '删除分配：设计师甲 · 设计' }).click();
  await expect(page.getByText('已删除分配')).toBeVisible();
  await expect(section).toContainText('还没有分配');
});

test('需求详情：只读成员能看到分配，但没有新增和删除', async ({ request, browser }) => {
  const productId = await createProduct(request);
  const req = await createRequirement(request, productId, '上传提速');
  const designer = await createMember(request, '设计师甲');
  const tags = (await json<{ tags: Array<{ id: string; name: string }> }>(request.get('/api/v1/orgs/acme/function-tags'))).tags;
  await ok(request.post(`/api/v1/orgs/acme/requirements/${req.id}/assignments`, { data: { memberId: designer, functionTagId: tags.find((x) => x.name === '设计')!.id } }));

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const viewerId = await acceptInvite(page, request, { email: 'viewer@example.com', orgRole: 'member', name: '只读成员' });
  await ok(request.put(`/api/v1/orgs/acme/products/${productId}/roles/${viewerId}`, { data: { role: 'viewer' } }));

  await page.goto(`/acme/requirements/${req.displayKey}`);
  const section = page.getByRole('region', { name: '分配', exact: true });
  await expect(section).toContainText('设计师甲 · 设计');
  await expect(section.getByRole('button', { name: '添加分配' })).toHaveCount(0);
  await expect(section.getByRole('button', { name: /删除分配/ })).toHaveCount(0);
  await ctx.close();
});
