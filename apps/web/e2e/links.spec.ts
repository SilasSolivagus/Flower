import { type APIRequestContext, expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { acceptInvite, createDocument, createIteration, createProduct, createRequirement, expectNoPageOverflow, json, login, ok, OWNER, setupInstance } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

async function requirementWith(request: APIRequestContext, productId: string, title: string, description: string): Promise<{ id: string; displayKey: string }> {
  return (await json<{ requirement: { id: string; displayKey: string } }>(request.post(`/api/v1/orgs/acme/products/${productId}/requirements`, { data: { title, description } })))
    .requirement;
}

test('需求描述里的链接卡：改标题后链接不断，点击跳转；目标的「被引用」列出来源与上下文', async ({ page, request }) => {
  const productId = await createProduct(request);
  const target = await createRequirement(request, productId, '登录改版'); // PAN-1
  const src = await requirementWith(request, productId, '引用方', '依赖 [[PAN-1]] 的接口。'); // PAN-2
  await ok(request.patch(`/api/v1/orgs/acme/requirements/${target.id}`, { data: { title: '登录改版二期' } }));
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/requirements/${src.displayKey}`);
  await page.getByRole('region', { name: '描述' }).getByRole('link', { name: 'PAN-1 登录改版二期 待处理' }).click();
  await expect(page).toHaveURL(/\/acme\/requirements\/PAN-1$/);
  const back = page.getByRole('region', { name: /被引用/ });
  await expect(back.getByRole('link', { name: /PAN-2/ })).toContainText('引用方');
  await expect(back).toContainText('需求描述');
  await expect(back).toContainText('依赖 [[PAN-1]] 的接口。');
});

test('迭代改名后链接不断；PRD 小节有效、改名后失效；迭代、任务、PRD 详情页的「被引用」', async ({ page, request }) => {
  const productId = await createProduct(request);
  const iterationId = await createIteration(request, productId, '迭代0316', '2026-03-02', '2026-03-13');
  const task = (await json<{ task: { displayKey: string } }>(request.post('/api/v1/orgs/acme/tasks', { data: { iterationId, title: '接口联调' } }))).task;
  const doc = await createDocument(request, productId, { title: '登录 PRD' });
  await ok(request.put(`/api/v1/orgs/acme/documents/${doc.id}/content`, { data: { baseVersion: doc.version, markdown: `## 1. 背景\n\n排期见 [[迭代:迭代0316]]，任务 [[${task.displayKey}]]。` } }));
  const src = await requirementWith(request, productId, '引用方', `排期 [[迭代:迭代0316]]，文档 [[${doc.displayKey}#背景]] 与 [[${doc.displayKey}#方案]]。`);
  await ok(request.patch(`/api/v1/orgs/acme/iterations/${iterationId}`, { data: { name: '迭代0316-改' } }));
  await login(page, OWNER.email, OWNER.password);

  await page.goto(`/acme/requirements/${src.displayKey}`);
  const desc = page.getByRole('region', { name: '描述' });
  await expect(desc.getByRole('link', { name: '迭代:迭代0316-改 规划中' })).toBeVisible();
  await expect(desc.getByRole('link', { name: `${doc.displayKey}#背景 登录 PRD 草稿` })).toBeVisible();
  await expect(desc.getByRole('link', { name: `${doc.displayKey}#方案 登录 PRD 草稿 小节已失效` })).toBeVisible();

  await ok(
    request.put(`/api/v1/orgs/acme/documents/${doc.id}/content`, {
      data: { baseVersion: doc.version + 1, markdown: `## 1. 现状\n\n排期见 [[迭代:迭代0316-改]]，任务 [[${task.displayKey}]]。` },
    }),
  );
  await page.reload();
  await expect(desc.getByRole('link', { name: `${doc.displayKey}#背景 登录 PRD 草稿 小节已失效` })).toBeVisible();

  await page.goto(`/acme/iterations/${iterationId}`);
  const itBack = page.getByRole('region', { name: /被引用/ });
  await expect(itBack.getByRole('link', { name: new RegExp(`^${src.displayKey} `) })).toBeVisible();
  await expect(itBack.getByRole('link', { name: new RegExp(`^${doc.displayKey} `) })).toBeVisible();
  await expect(itBack).toContainText('小节「1. 现状」');

  await page.goto(`/acme/tasks/${task.displayKey}`);
  await expect(page.getByRole('region', { name: /被引用/ }).getByRole('link', { name: new RegExp(`^${doc.displayKey} `) })).toBeVisible();

  await page.goto(`/acme/documents/${doc.displayKey}`);
  await expect(page.getByRole('region', { name: /被引用/ }).getByRole('link', { name: new RegExp(`^${src.displayKey} `) })).toBeVisible();
});

test('评论里的链接卡：需求评论与 PRD 评论，显示文字替代标题', async ({ page, request }) => {
  const productId = await createProduct(request);
  const req = await createRequirement(request, productId, '登录改版');
  const doc = await createDocument(request, productId, { title: '登录 PRD' });
  await ok(request.post(`/api/v1/orgs/acme/requirements/${req.id}/comments`, { data: { body: `PRD 见 [[${doc.displayKey}]]` } }));
  await ok(request.post(`/api/v1/orgs/acme/documents/${doc.id}/comments`, { data: { body: `对应需求 [[${req.displayKey}|登录]]` } }));
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/requirements/${req.displayKey}`);
  await expect(page.getByRole('region', { name: /^评论/ }).getByRole('link', { name: `${doc.displayKey} 登录 PRD 草稿` })).toBeVisible();
  await page.goto(`/acme/documents/${doc.displayKey}`);
  await page.getByRole('region', { name: /^评论/ }).getByRole('link', { name: `${req.displayKey} 登录 待处理` }).click();
  await expect(page).toHaveURL(new RegExp(`/acme/requirements/${req.displayKey}$`));
});

test('看不到目标所在产品时只显示编号', async ({ browser, request }) => {
  const pan = await createProduct(request);
  const other = await createProduct(request, '文档', 'DOC');
  await createRequirement(request, other, '保密需求');
  const src = await requirementWith(request, pan, '引用方', '见 [[DOC-1]]');
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const guestId = await acceptInvite(page, request, { email: 'guest@example.com', orgRole: 'guest', name: '访客甲' });
  await ok(request.put(`/api/v1/orgs/acme/products/${pan}/roles/${guestId}`, { data: { role: 'viewer' } }));
  await page.goto(`/acme/requirements/${src.displayKey}`);
  const desc = page.getByRole('region', { name: '描述' });
  await expect(desc).toContainText('DOC-1');
  await expect(desc).not.toContainText('保密需求');
  await expect(desc.getByRole('link')).toHaveCount(0);
  await ctx.close();
});

test('「被引用」区块在 1440 与 760 宽度下不让页面横向滚动', async ({ page, request }) => {
  const productId = await createProduct(request);
  const target = await createRequirement(request, productId, '登录改版');
  await requirementWith(request, productId, '一个标题很长很长很长很长很长很长很长很长很长很长很长很长的引用方', `${'很长的上下文'.repeat(30)} [[PAN-1]]`);
  await login(page, OWNER.email, OWNER.password);
  for (const width of [1440, 760]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/acme/requirements/${target.displayKey}`);
    await expect(page.getByRole('region', { name: /被引用/ })).toContainText('需求描述');
    await expectNoPageOverflow(page);
  }
});

