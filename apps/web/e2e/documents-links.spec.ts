import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { createDocument, createProduct, createRequirement, login, ok, OWNER, presetTemplateId, setupInstance } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

const AUTOSAVE_MS = 1000;

test('PRD 正文：输入 [[ 弹出补全、回车插入；自动保存后显示链接卡，刷新后仍在，点击跳转', async ({ page, request }) => {
  const productId = await createProduct(request);
  await createRequirement(request, productId, '登录改版');
  const doc = await createDocument(request, productId, { title: '引用', templateId: await presetTemplateId(request, productId) });
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/documents/${doc.displayKey}`);
  const body = page.getByRole('region', { name: '正文' });
  await expect(body).toContainText('1. 背景介绍');
  await body.locator('.bn-block-content').last().click();
  await page.keyboard.press('End');
  await page.keyboard.type('依赖 [[登录');
  await expect(page.getByRole('option', { name: /PAN-1 登录改版/ })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(body).toContainText('依赖 [[PAN-1]]');
  await expect(body.getByRole('status')).toHaveText('已保存');
  await expect(body.getByRole('link', { name: 'PAN-1 登录改版 待处理' })).toBeVisible();
  await page.reload();
  const again = page.getByRole('region', { name: '正文' });
  await expect(again).toContainText('依赖 [[PAN-1]]');
  await again.getByRole('link', { name: 'PAN-1 登录改版 待处理' }).click();
  await expect(page).toHaveURL(/\/acme\/requirements\/PAN-1$/);
});

test('PRD 正文：选中 PRD 后继续选小节；点击小节链接跳到详情页并滚动到该小节', async ({ page, request }) => {
  const productId = await createProduct(request);
  const target = await createDocument(request, productId, { title: '登录 PRD' }); // PAN-PRD-1
  const filler = Array.from({ length: 80 }, (_, i) => `第 ${i + 1} 段说明文字。`).join('\n\n');
  await ok(request.put(`/api/v1/orgs/acme/documents/${target.id}/content`, { data: { baseVersion: target.version, markdown: `## 1. 背景\n\n${filler}\n\n## 2. 需求说明\n\n要点` } }));
  const doc = await createDocument(request, productId, { title: '引用', templateId: await presetTemplateId(request, productId) }); // PAN-PRD-2
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/documents/${doc.displayKey}`);
  const body = page.getByRole('region', { name: '正文' });
  await expect(body).toContainText('1. 背景介绍');
  await body.locator('.bn-block-content').last().click();
  await page.keyboard.press('End');
  await page.keyboard.type('详见 [[PAN-PRD-1');
  await expect(page.getByRole('option', { name: /PAN-PRD-1 登录 PRD/ })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('option', { name: /整篇/ })).toBeVisible();
  await page.getByRole('option', { name: /PAN-PRD-1#需求说明/ }).click();
  await expect(body).toContainText('详见 [[PAN-PRD-1#需求说明]]');
  await expect(body.getByRole('status')).toHaveText('已保存');
  await body.getByRole('link', { name: 'PAN-PRD-1#需求说明 登录 PRD 草稿' }).click();
  await expect(page).toHaveURL(/\/acme\/documents\/PAN-PRD-1\?section=/);
  await expect(page.getByRole('region', { name: '正文' }).getByRole('heading', { name: '2. 需求说明' })).toBeInViewport();
});

test('链接卡不触发自动保存：打开含链接的 PRD 后不发保存请求；不存在的目标显示为灰色', async ({ page, request }) => {
  const productId = await createProduct(request);
  await createRequirement(request, productId, '登录改版');
  const doc = await createDocument(request, productId, { title: '只看' });
  await ok(request.put(`/api/v1/orgs/acme/documents/${doc.id}/content`, { data: { baseVersion: doc.version, markdown: '## 背景\n\n依赖 [[PAN-1]] 与 [[PAN-99]]' } }));
  let puts = 0;
  page.on('request', (r) => {
    if (r.url().endsWith(`/documents/${doc.id}/content`) && r.method() === 'PUT') puts += 1;
  });
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/documents/${doc.displayKey}`);
  const body = page.getByRole('region', { name: '正文' });
  await expect(body.getByRole('link', { name: 'PAN-1 登录改版 待处理' })).toBeVisible();
  await expect(body.locator('.wikilink-card[data-state="missing"]')).toHaveAttribute('aria-label', 'PAN-99 目标不存在');
  await page.waitForTimeout(AUTOSAVE_MS * 2 + 500);
  expect(puts).toBe(0);
  await expect(body.getByRole('status')).toHaveText('已保存');
});

test('PRD 正文补全：输入法组字时回车不选条目；改了查询立刻回车，不插入上一次查询的结果', async ({ page, request }) => {
  const productId = await createProduct(request);
  await createRequirement(request, productId, '登录改版'); // PAN-1
  await createRequirement(request, productId, '支付改版'); // PAN-2
  const doc = await createDocument(request, productId, { title: '引用', templateId: await presetTemplateId(request, productId) });
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/documents/${doc.displayKey}`);
  const body = page.getByRole('region', { name: '正文' });
  await expect(body).toContainText('1. 背景介绍');
  await body.locator('.bn-block-content').last().click();
  await page.keyboard.press('End');
  await page.keyboard.type('依赖 [[登录');
  await expect(page.getByRole('option', { name: /PAN-1 登录改版/ })).toBeVisible();
  // 输入法组字中的回车：Chrome 为 isComposing，Safari 确认组字时为 keyCode 229
  await body.locator('.bn-editor').evaluate((el) => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true }));
  });
  await expect(page.getByRole('option', { name: /PAN-1 登录改版/ })).toBeVisible();
  await expect(body).toContainText('依赖 [[登录');
  // 改查询后立刻回车：列表还是「登录」的结果，回车不插入
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('支付');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('option', { name: /PAN-2 支付改版/ })).toBeVisible();
  await expect(body).toContainText('依赖 [[支付');
  await expect(body).not.toContainText('[[PAN-1]]');
  await page.keyboard.press('Enter');
  await expect(body).toContainText('依赖 [[PAN-2]]');
  await expect(body).not.toContainText('PAN-1');
});

test('链接旁边的文字可以划词评论：引用里没有链接卡的说明文字，评论定位到原文', async ({ page, request }) => {
  const productId = await createProduct(request);
  await createRequirement(request, productId, '登录改版');
  const doc = await createDocument(request, productId, { title: '评论' });
  await ok(request.put(`/api/v1/orgs/acme/documents/${doc.id}/content`, { data: { baseVersion: doc.version, markdown: '## 背景\n\n依赖 [[PAN-1]] 的登录接口需要限流' } }));
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/documents/${doc.displayKey}`);
  const body = page.getByRole('region', { name: '正文' });
  await expect(body.getByRole('link', { name: 'PAN-1 登录改版 待处理' })).toBeVisible();
  // 在段首三击选中整段（点在链接卡上会跳转）
  const para = body.getByText(/的登录接口需要限流/);
  const box = (await para.boundingBox())!;
  await para.click({ clickCount: 3, position: { x: 4, y: box.height / 2 } });
  await page.getByRole('button', { name: '评论', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '评论选中的文字' });
  await expect(dialog).toContainText('依赖 [[PAN-1]] 的登录接口需要限流');
  await expect(dialog).not.toContainText('登录改版');
  await dialog.getByLabel('评论内容').fill('限流阈值是多少？');
  await dialog.getByRole('button', { name: '发表' }).click();
  const anchored = page.getByRole('region', { name: '评论' }).getByRole('listitem').filter({ hasText: '限流阈值是多少？' });
  await expect(anchored).toContainText('位于「背景」');
  await expect(anchored).not.toContainText('已失效');
});
