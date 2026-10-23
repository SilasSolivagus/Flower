import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { acceptInvite, createBrief, createIteration, createProduct, createRequirement, createTask, json, login, ok, OWNER, readToken, setupInstance } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

test('工作项与任务列表是真页面，760 能看到标题和状态', async ({ page, request }) => {
  await login(page, OWNER.email, OWNER.password);
  await page.setViewportSize({ width: 760, height: 800 });
  await page.goto('/acme/work-items');
  await expect(page.getByRole('heading', { name: '工作项' })).toBeVisible();
  await expect(page.getByText('还没有工作项')).toBeVisible();
  const productId = await createProduct(request);
  await ok(request.post('/api/v1/orgs/acme/work-items', { data: { title: '协助客服', productId } }));
  await page.reload();
  await expect(page.getByRole('link', { name: '协助客服' })).toBeVisible();
  await expect(page.getByRole('table', { name: '工作项' })).toContainText('进行中');
  await page.goto('/acme/tracking');
  await page.getByRole('link', { name: '只看工作项' }).click();
  await expect(page).toHaveURL(/\/acme\/work-items$/);

  const iterationId = await createIteration(request, productId, '迭代一', '2026-10-01', '2026-10-14');
  await createTask(request, { title: '排期任务', productId, iterationId, assigneeMemberId: (await json<{ me: { memberId: string } }>(request.get('/api/v1/orgs/acme'))).me.memberId });
  await page.goto('/acme');
  // 「此刻迭代」空态是「查看全部迭代」，和「我的任务」的「查看全部」不是同一个链接。
  await page.getByRole('region', { name: /我的任务/ }).getByRole('link', { name: '查看全部', exact: true }).click();
  await expect(page).toHaveURL(/\/acme\/tasks$/);
  await expect(page.getByRole('heading', { name: '我的任务' })).toBeVisible();
  const table = page.getByRole('table', { name: '我的任务' });
  await expect(table.getByRole('link', { name: '排期任务' })).toBeVisible();
  await expect(table).toContainText('待开始');
});

test('需求标签可挂可卸，查看者没有添加', async ({ page, request, browser }) => {
  const productId = await createProduct(request);
  const req = await createRequirement(request, productId, '要打标的需求');
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/requirements/${req.displayKey}`);
  const tags = page.getByLabel('需求标签');
  await expect(tags).toContainText('暂无标签');
  await tags.getByRole('button', { name: '添加' }).click();
  await page.getByLabel('新标签名称').fill('体验');
  await page.getByRole('button', { name: '新建', exact: true }).click();
  await expect(tags.getByText('体验')).toBeVisible();
  await tags.getByRole('button', { name: '移除标签 体验' }).click();
  await expect(tags).toContainText('暂无标签');

  await page.goto('/acme/settings/requirement-tags');
  await page.getByLabel('新标签名称').fill('性能');
  await page.getByRole('button', { name: '添加' }).click();
  await expect(page.getByText('性能')).toBeVisible();

  const viewerPage = await browser.newPage();
  const viewer = await acceptInvite(viewerPage, request, { email: 'view@example.com', orgRole: 'member', name: '查看者' });
  await ok(request.put(`/api/v1/orgs/acme/products/${productId}/roles/${viewer}`, { data: { role: 'viewer' } }));
  await viewerPage.goto(`/acme/requirements/${req.displayKey}`);
  await expect(viewerPage.getByLabel('需求标签').getByRole('button', { name: '添加' })).toHaveCount(0);
  await viewerPage.close();
});

test('跟进批量改状态有确认，部分失败会说明', async ({ page, request }) => {
  const productId = await createProduct(request);
  await ok(request.post('/api/v1/orgs/acme/work-items', { data: { title: '可改状态', productId } }));
  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme/tracking');
  await page.getByRole('checkbox', { name: '选择 W-1' }).check();
  await page.getByRole('button', { name: '改状态' }).click();
  await expect(page.getByRole('dialog')).toContainText('改状态');
  await page.route('**/api/v1/orgs/acme/work-items/batch-status', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ updated: 0, failed: [{ id: 'x', reason: '无权或不存在' }] }),
    }),
  );
  await page.getByRole('button', { name: '确认' }).click();
  await expect(page.getByRole('status')).toContainText('成功 0 条 / 失败 1 条');
  await expect(page.getByRole('status')).toContainText('无权或不存在');
});

test('迭代按产品筛选时计数等于行数，专项只在全部里', async ({ page, request }) => {
  const pan = await createProduct(request, '网盘', 'PAN');
  const doc = await createProduct(request, '文档', 'DOC');
  await createIteration(request, pan, '网盘迭代', '2026-10-01', '2026-10-14');
  await createIteration(request, doc, '文档迭代', '2026-10-01', '2026-10-14');
  await ok(request.post('/api/v1/orgs/acme/iterations', { data: { type: 'special', name: '专项迭代', startDate: '2026-10-01', endDate: '2026-10-14' } }));
  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme/iterations');
  await expect(page.getByText('显示 3 条')).toBeVisible();
  await expect(page.getByRole('link', { name: '专项迭代' })).toBeVisible();
  await page.getByRole('combobox', { name: '产品' }).click();
  await page.getByRole('option', { name: '网盘' }).click();
  await expect(page.getByText('显示 1 条')).toBeVisible();
  await expect(page.getByRole('link', { name: '网盘迭代' })).toBeVisible();
  await expect(page.getByRole('link', { name: '专项迭代' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: '文档迭代' })).toHaveCount(0);
});

test('甘特窄屏列出标题和状态，只读 Token 有单独提示', async ({ page, request }) => {
  const productId = await createProduct(request);
  const iterationId = await createIteration(request, productId, '迭代一', '2026-10-01', '2026-10-14');
  await createTask(request, { title: '窄屏任务', productId, iterationId, status: 'doing' });
  await readToken(request);
  await login(page, OWNER.email, OWNER.password);
  await page.setViewportSize({ width: 760, height: 800 });
  await page.goto(`/acme/iterations/${iterationId}`);
  await page.getByRole('tab', { name: '甘特' }).click();
  const list = page.getByRole('list', { name: '任务' });
  await expect(list.getByRole('link', { name: '窄屏任务' })).toBeVisible();
  await expect(list).toContainText('进行中');
  await page.goto('/acme/settings/agents');
  await expect(page.getByText('只读 Token 不能新建或修改数据。')).toBeVisible();
});

test('失败简报可以去改，已删除文档不显示无权访问', async ({ page, request }) => {
  const productId = await createProduct(request);
  const brief = await createBrief(request, productId, { title: '空白简报' });
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/documents/${brief.displayKey}`);
  await page.getByRole('button', { name: /去改「/ }).first().click();
  const target = page.locator('.brief-section-target');
  await expect(target).toBeVisible();
  const top = await target.evaluate((el) => el.getBoundingClientRect().top);
  expect(top).toBeGreaterThanOrEqual(56);
  await expect(page).not.toHaveURL(/[?&]section=/);

  await page.route('**/api/v1/orgs/acme/documents/PAN-PRD-404', (route) =>
    route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'not_found', message: '这份文档已删除，通知里的链接已失效' } }),
    }),
  );
  await page.goto('/acme/documents/PAN-PRD-404');
  await expect(page.getByText('这份文档已删除')).toBeVisible();
  await expect(page.getByText('通知里的链接已失效。')).toBeVisible();
  await expect(page.getByRole('heading', { name: '无权访问' })).toHaveCount(0);
});
