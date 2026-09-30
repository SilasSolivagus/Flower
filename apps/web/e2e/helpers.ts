import { type APIRequestContext, type APIResponse, expect, type Page } from '@playwright/test';

export const OWNER = { email: 'owner@example.com', password: 'password123', name: '林澄' };

export async function ok(pending: Promise<APIResponse>): Promise<APIResponse> {
  const res = await pending;
  expect(res.ok(), `${res.url()} → ${res.status()}`).toBeTruthy();
  return res;
}

export async function json<T>(pending: Promise<APIResponse>): Promise<T> {
  return (await (await ok(pending)).json()) as T;
}

export async function createProduct(request: APIRequestContext, name = '网盘', key = 'PAN'): Promise<string> {
  const res = await ok(request.post('/api/v1/orgs/acme/products', { data: { name, key } }));
  return (await res.json()).product.id as string;
}

export async function createRequirement(request: APIRequestContext, productId: string, title: string): Promise<{ id: string; displayKey: string }> {
  return (await json<{ requirement: { id: string; displayKey: string } }>(request.post(`/api/v1/orgs/acme/products/${productId}/requirements`, { data: { title } })))
    .requirement;
}

export async function setupInstance(request: APIRequestContext, org = { name: '测试组织', slug: 'acme' }): Promise<void> {
  const res = await request.post('/api/v1/setup', {
    data: { admin: { email: OWNER.email, name: OWNER.name, password: OWNER.password }, org },
  });
  expect(res.status()).toBe(201);
}

export async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('邮箱').fill(email);
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: '登录' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'));
}
