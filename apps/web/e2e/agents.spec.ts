import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { login, OWNER, setupInstance } from './helpers';

test('创建 Agent，签发只读 Token；Token 只能读指定产品，撤销后失效', async ({ page, request, playwright }) => {
  await resetDatabase();
  await setupInstance(request);
  await request.post('/api/v1/orgs/acme/products', { data: { name: '网盘', key: 'PAN' } });
  await request.post('/api/v1/orgs/acme/products', { data: { name: '会员', key: 'VIP' } });
  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme/settings/agents');

  await page.getByRole('button', { name: '创建 Agent' }).click();
  await page.getByLabel('Agent 名称').fill('PRD 助手');
  await page.getByRole('button', { name: '创建' }).click();
  await expect(page.getByRole('row', { name: /PRD 助手/ })).toBeVisible();

  await page.getByRole('button', { name: '签发 Token' }).click();
  await page.getByLabel('Token 名称').fill('Claude Code');
  await page.getByRole('radio', { name: '指定产品' }).click();
  await page.getByRole('checkbox', { name: 'PAN 网盘' }).check();
  await page.getByRole('radio', { name: '只读' }).click();
  await page.getByRole('button', { name: '签发' }).click();
  const token = await page.getByLabel('Token（只显示一次）').inputValue();
  expect(token).toMatch(/^flw_/);
  await page.getByRole('button', { name: '我已保存' }).click();
  await expect(page.getByRole('row', { name: /Claude Code/ }).getByText('PAN · 只读')).toBeVisible();

  const api = await playwright.request.newContext({ baseURL: 'http://localhost:3100', extraHTTPHeaders: { authorization: `Bearer ${token}` } });
  const list = await (await api.get('/api/v1/orgs/acme/products')).json();
  expect(list.products.map((p: { key: string }) => p.key)).toEqual(['PAN']);
  expect((await api.post('/api/v1/orgs/acme/products', { data: { name: 'x', key: 'XX' } })).status()).toBe(403);

  await page.getByRole('row', { name: /Claude Code/ }).getByRole('button', { name: '撤销' }).click();
  await page.getByRole('button', { name: '确认撤销' }).click();
  await expect(page.getByRole('row', { name: /Claude Code/ }).getByText('已撤销')).toBeVisible();
  expect((await api.get('/api/v1/orgs/acme/products')).status()).toBe(401);
  await api.dispose();
});
