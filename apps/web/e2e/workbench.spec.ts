import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { applyReviewWorkflow, createIteration, createProduct, createTask, FAIL_500, json, login, ok, OWNER, setupInstance } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

test('登录后进入工作台：跨组织汇总负责的需求、我的任务、等我签字与未读评论，行可以点进去', async ({ page, request, playwright }) => {
  const productId = await createProduct(request);
  const me = (await json<{ me: { memberId: string } }>(request.get('/api/v1/orgs/acme'))).me.memberId;
  const boss = (await json<{ member: { id: string } }>(request.post('/api/v1/orgs/acme/members', { data: { displayName: '老板乙' } }))).member.id;
  await applyReviewWorkflow(request, productId, boss);
  const req = (
    await json<{ requirement: { id: string } }>(request.post(`/api/v1/orgs/acme/products/${productId}/requirements`, { data: { title: '上传提速', ownerMemberId: me } }))
  ).requirement;
  await ok(request.put(`/api/v1/orgs/acme/requirements/${req.id}/checks/feasibility`, { data: { state: 'passed' } }));
  const iterationId = await createIteration(request, productId, '迭代0105', '2026-01-05', '2026-01-16');
  await createTask(request, { iterationId, requirementId: req.id, title: '接口联调', assigneeMemberId: me });

  // 用 Agent 的 Token 发一条评论，作为「别人的评论」
  const agent = (await json<{ member: { id: string } }>(request.post('/api/v1/orgs/acme/agents', { data: { displayName: '评审助手' } }))).member.id;
  const { token } = await json<{ token: string }>(
    request.post('/api/v1/orgs/acme/tokens', { data: { memberId: agent, name: '评论', scope: { products: 'all', access: 'write' } } }),
  );
  const bot = await playwright.request.newContext({ baseURL: 'http://localhost:3100', extraHTTPHeaders: { authorization: `Bearer ${token}` } });
  await ok(bot.post(`/api/v1/orgs/acme/requirements/${req.id}/comments`, { data: { body: '接口文档在哪？' } }));
  await bot.dispose();

  // 第二个组织里也有一条自己负责的需求
  await ok(request.post('/api/v1/orgs', { data: { name: '第二组织', slug: 'second' } }));
  const secondProduct = (await json<{ product: { id: string } }>(request.post('/api/v1/orgs/second/products', { data: { name: '文档', key: 'DOC' } }))).product.id;
  const secondMe = (await json<{ me: { memberId: string } }>(request.get('/api/v1/orgs/second'))).me.memberId;
  await ok(request.post(`/api/v1/orgs/second/products/${secondProduct}/requirements`, { data: { title: '另一个组织的需求', ownerMemberId: secondMe } }));

  await login(page, OWNER.email, OWNER.password);
  await page.waitForURL('**/acme');
  await expect(page.getByRole('heading', { name: '工作台', level: 1 })).toBeVisible();
  const owned = page.getByRole('region', { name: /我负责的需求/ });
  await expect(owned.getByRole('link', { name: /PAN-1/ })).toBeVisible();
  await expect(owned.getByRole('link', { name: /DOC-1/ })).toContainText('第二组织');
  await expect(page.getByRole('region', { name: /我的任务/ }).getByRole('link', { name: /接口联调/ })).toBeVisible();
  const sign = page.getByRole('region', { name: /等我签字/ });
  await expect(sign.getByRole('link')).toHaveCount(2);
  await expect(sign.getByRole('link').filter({ hasText: '代 老板乙' })).toBeVisible();
  const unread = page.getByRole('region', { name: /未读评论/ });
  await expect(unread.getByRole('link', { name: /PAN-1/ })).toContainText('1 条未读');
  await unread.getByRole('link', { name: /PAN-1/ }).click();
  await expect(page).toHaveURL(/\/acme\/requirements\/PAN-1$/);
});

test('工作台加载失败（5xx）显示重试', async ({ page }) => {
  await login(page, OWNER.email, OWNER.password);
  await page.route('**/api/v1/me/workbench', (route) => route.fulfill(FAIL_500));
  await page.goto('/acme');
  await expect(page.getByText('加载工作台失败，请重试。')).toBeVisible({ timeout: 15_000 });
  await page.unroute('**/api/v1/me/workbench');
  await page.getByRole('button', { name: '重试' }).click();
  await expect(page.getByRole('region', { name: /我负责的需求/ })).toBeVisible();
});
