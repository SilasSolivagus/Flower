import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { createDocument, createProduct, json, login, ok, OWNER, setupInstance } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

test('评论锚点：未解决的划词评论在正文中高亮，点击后评论区滚动到该条并标出；已解决、已失效的不高亮', async ({ page, request }) => {
  const productId = await createProduct(request);
  const doc = await createDocument(request, productId, { title: '锚点' });
  const filler = Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 段说明文字。`).join('\n\n');
  const md = (plan: string) => `## 1. 背景\n\n上传大文件时经常超时，需要重试。\n\n下载也会失败。\n\n## 2. 方案\n\n${plan}\n\n${filler}`;
  await ok(request.put(`/api/v1/orgs/acme/documents/${doc.id}/content`, { data: { baseVersion: doc.version, markdown: md('采用分片上传。') } }));
  const add = async (body: string, quote: string, prefix = '', suffix = '') =>
    (await json<{ comment: { id: string } }>(request.post(`/api/v1/orgs/acme/documents/${doc.id}/comments`, { data: { body, anchor: { quote, prefix, suffix } } }))).comment;
  const open = await add('超时阈值是多少？', '经常超时', '上传大文件时', '，需要重试');
  const done = await add('已确认', '下载也会失败');
  await ok(request.post(`/api/v1/orgs/acme/document-comments/${done.id}/resolve`, { data: { resolved: true } }));
  const stale = await add('分片大小？', '采用分片上传');
  await ok(request.put(`/api/v1/orgs/acme/documents/${doc.id}/content`, { data: { baseVersion: doc.version + 1, markdown: md('改用断点续传。') } }));

  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/documents/${doc.displayKey}`);
  const body = page.getByRole('region', { name: '正文' });
  await expect(body).toContainText('经常超时');
  await expect(body.locator(`[data-comment-id="${open.id}"]`)).toHaveText('经常超时');
  await expect(body.locator('[data-comment-id]')).toHaveCount(1);
  await expect(body.locator(`[data-comment-id="${done.id}"]`)).toHaveCount(0);
  await expect(body.locator(`[data-comment-id="${stale.id}"]`)).toHaveCount(0);

  const item = page.locator(`#comment-${open.id}`);
  await expect(item).not.toBeInViewport();
  await body.locator(`[data-comment-id="${open.id}"]`).click();
  await expect(item).toHaveAttribute('aria-current', 'true');
  await expect(item).toBeInViewport();
  await expect(body.locator('.comment-anchor-active')).toHaveText('经常超时');
});
