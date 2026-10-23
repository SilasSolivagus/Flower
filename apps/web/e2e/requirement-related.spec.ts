import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { acceptInvite, json, login, ok, OWNER, setupInstance } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

test('需求列表默认只看我相关，可以切到全部并记住选择', async ({ page, request }) => {
  const productId = await json<{ product: { id: string } }>(request.post('/api/v1/orgs/acme/products', { data: { name: '网盘', key: 'PAN' } })).then((d) => d.product.id);
  const me = (await json<{ me: { memberId: string } }>(request.get('/api/v1/orgs/acme'))).me.memberId;
  const other = (await json<{ member: { id: string } }>(request.post('/api/v1/orgs/acme/members', { data: { displayName: '其他人' } }))).member.id;
  const design = (await json<{ tags: Array<{ id: string; name: string }> }>(request.get('/api/v1/orgs/acme/function-tags'))).tags.find((t) => t.name === '设计')!.id;
  const post = (title: string, body: Record<string, unknown> = {}) =>
    ok(request.post(`/api/v1/orgs/acme/products/${productId}/requirements`, { data: { title, ...body } }));
  await post('我负责的需求', { ownerMemberId: me, requesterMemberId: other });
  await post('我提出的需求', { ownerMemberId: other, requesterMemberId: me });
  const assigned = await json<{ requirement: { id: string } }>(
    request.post(`/api/v1/orgs/acme/products/${productId}/requirements`, { data: { title: '分配给我的需求', ownerMemberId: other, requesterMemberId: other } }),
  );
  await ok(request.post(`/api/v1/orgs/acme/requirements/${assigned.requirement.id}/assignments`, { data: { memberId: me, functionTagId: design } }));
  await post('别人的需求', { ownerMemberId: other, requesterMemberId: other });

  await login(page, OWNER.email, OWNER.password);
  await page.evaluate(() => localStorage.removeItem('flower.req.relatedScope'));
  const mineReq = page.waitForResponse(
    (r) => r.url().includes(`/products/${productId}/requirements?`) && r.url().includes('related=me') && r.request().method() === 'GET' && r.ok(),
  );
  await page.goto('/acme/requirements');
  const mine = await mineReq;
  expect(new URL(mine.url()).searchParams.has('owner')).toBe(false);
  expect(new URL(mine.url()).searchParams.has('requester')).toBe(false);
  await expect(page.getByRole('button', { name: '我的' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: '看全部' })).toBeVisible();
  await expect(page.getByRole('link', { name: '我负责的需求' })).toBeVisible();
  await expect(page.getByRole('link', { name: '我提出的需求' })).toBeVisible();
  await expect(page.getByRole('link', { name: '分配给我的需求' })).toBeVisible();
  await expect(page.getByRole('link', { name: '别人的需求' })).toHaveCount(0);
  await expect(page.getByText(/网盘 · 我相关 · 共/)).toBeVisible();

  const allReq = page.waitForResponse((r) => {
    if (!r.url().includes(`/products/${productId}/requirements?`) || r.request().method() !== 'GET' || !r.ok()) return false;
    return !new URL(r.url()).searchParams.has('related');
  });
  await page.getByRole('button', { name: '看全部' }).click();
  await allReq;
  await expect(page.getByRole('button', { name: '看全部' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('link', { name: '别人的需求' })).toBeVisible();
  await expect(page.getByText(/网盘 · 全部 · 共/)).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('flower.req.relatedScope'))).toBe('all');

  await page.reload();
  await expect(page.getByRole('button', { name: '看全部' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('link', { name: '别人的需求' })).toBeVisible();

  await page.getByRole('button', { name: '我的' }).click();
  await expect(page.getByRole('link', { name: '别人的需求' })).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('flower.req.relatedScope'))).toBe('me');
  await page.reload();
  await expect(page.getByRole('button', { name: '我的' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('link', { name: '别人的需求' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: '我负责的需求' })).toBeVisible();
});

test('查看者看全部仍只读', async ({ browser, request }) => {
  const productId = await json<{ product: { id: string } }>(request.post('/api/v1/orgs/acme/products', { data: { name: '网盘', key: 'PAN' } })).then((d) => d.product.id);
  const other = (await json<{ member: { id: string } }>(request.post('/api/v1/orgs/acme/members', { data: { displayName: '其他人' } }))).member.id;
  await ok(request.post(`/api/v1/orgs/acme/products/${productId}/requirements`, { data: { title: '别人的需求', ownerMemberId: other } }));
  const viewer = await browser.newPage();
  const viewerId = await acceptInvite(viewer, request, { email: 'viewer@example.com', orgRole: 'member', name: '只读甲' });
  await ok(request.put(`/api/v1/orgs/acme/products/${productId}/roles/${viewerId}`, { data: { role: 'viewer' } }));
  await viewer.addInitScript(() => localStorage.setItem('flower.req.relatedScope', 'all'));
  await viewer.goto('/acme/requirements');
  await expect(viewer.getByRole('button', { name: '看全部' })).toHaveAttribute('aria-pressed', 'true');
  await expect(viewer.getByRole('link', { name: '别人的需求' })).toBeVisible();
  await expect(viewer.getByRole('button', { name: '新建需求' })).toHaveCount(0);
  await viewer.close();
});
