import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { createDocument, createProduct, login, ok, OWNER, setupInstance } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

test('修订记录：任选两版按小节对比，恢复到旧版本', async ({ page, request }) => {
  const productId = await createProduct(request);
  const doc = await createDocument(request, productId, { title: '修订', externalUrl: 'https://docs.qq.com/doc/rev' });
  await ok(request.post(`/api/v1/orgs/acme/documents/${doc.id}/convert`, { data: { baseVersion: 1, markdown: '## 背景\n\n上传慢\n\n## 方案\n\n分片上传' } }));
  await ok(request.put(`/api/v1/orgs/acme/documents/${doc.id}/content`, { data: { baseVersion: 2, markdown: '## 背景\n\n上传慢且经常失败\n\n## 方案\n\n分片上传\n\n## 埋点\n\n记录耗时' } }));

  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/documents/${doc.displayKey}`);
  const revs = page.getByRole('complementary').getByRole('region', { name: '修订记录' });
  await expect(revs.getByRole('listitem')).toHaveCount(2);
  await expect(revs.getByRole('listitem').last()).toContainText('由外部文档转换');

  await revs.getByRole('button', { name: '对比第 2 版与上一版' }).click();
  const dialog = page.getByRole('dialog', { name: '对比修订' });
  await expect(dialog.getByRole('region', { name: '背景' })).toContainText('修改');
  await expect(dialog.getByRole('region', { name: '背景' })).toContainText('上传慢且经常失败');
  await expect(dialog.getByRole('region', { name: '埋点' })).toContainText('新增');
  await expect(dialog.getByRole('region', { name: '方案' })).toHaveCount(0);
  await dialog.getByRole('combobox', { name: '从' }).click();
  await page.getByRole('option', { name: '第 2 版' }).click();
  await expect(dialog).toContainText('请选择两个不同的版本');
  await page.keyboard.press('Escape');

  await revs.getByRole('button', { name: '恢复第 1 版' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '恢复' }).click();
  await expect(page.getByRole('region', { name: '正文' })).not.toContainText('经常失败');
  await expect(page.getByRole('region', { name: '正文' })).toContainText('上传慢');
  await expect(revs.getByRole('listitem').first()).toContainText('恢复到第 1 版');

  // 恢复后继续编辑正文：自动保存沿用恢复后的版本号，不报冲突
  const saved = page.waitForResponse((r) => r.url().endsWith(`/documents/${doc.id}/content`) && r.request().method() === 'PUT');
  await page.getByRole('region', { name: '正文' }).locator('.bn-block-content').last().click();
  await page.keyboard.press('End');
  await page.keyboard.type('恢复之后写的');
  expect((await saved).status()).toBe(200);
  await expect(page.getByRole('region', { name: '正文' }).getByRole('status')).toHaveText('已保存');
  await expect(page.getByRole('alert').filter({ hasText: '文档已被其他人修改' })).toHaveCount(0);
});

test('评论：选中文字评论，原文改动后标为已失效；整篇评论、回复、标为已解决', async ({ page, request }) => {
  const productId = await createProduct(request);
  const doc = await createDocument(request, productId, { title: '评论', externalUrl: 'https://docs.qq.com/doc/cmt' });
  await ok(request.post(`/api/v1/orgs/acme/documents/${doc.id}/convert`, { data: { baseVersion: 1, markdown: '## 背景\n\n上传大文件时经常超时\n\n## 方案\n\n分片上传' } }));

  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/documents/${doc.displayKey}`);
  await page.getByRole('region', { name: '正文' }).getByText('上传大文件时经常超时').click({ clickCount: 3 });
  await page.getByRole('button', { name: '评论', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '评论选中的文字' });
  await expect(dialog).toContainText('上传大文件时经常超时');
  await dialog.getByLabel('评论内容').fill('超时阈值是多少？');
  await dialog.getByRole('button', { name: '发表' }).click();
  const comments = page.getByRole('region', { name: '评论' });
  const anchored = comments.getByRole('listitem').filter({ hasText: '超时阈值是多少？' });
  await expect(anchored).toContainText('位于「背景」');

  await comments.getByLabel('发表评论').fill('整体同意');
  await comments.getByRole('button', { name: '发表' }).click();
  const whole = comments.getByRole('listitem').filter({ hasText: '整体同意' });
  await whole.getByRole('button', { name: '回复' }).click();
  await whole.getByLabel('回复内容').fill('收到');
  await whole.getByRole('button', { name: '发送回复' }).click();
  await expect(whole).toContainText('收到');
  await whole.getByRole('button', { name: '标为已解决' }).click();
  await expect(whole).toContainText('已解决');

  await ok(request.put(`/api/v1/orgs/acme/documents/${doc.id}/content`, { data: { baseVersion: 2, markdown: '## 背景\n\n上传大文件时偶尔失败\n\n## 方案\n\n分片上传' } }));
  await page.reload();
  await expect(page.getByRole('region', { name: '评论' }).getByRole('listitem').filter({ hasText: '超时阈值是多少？' })).toContainText('已失效');
});
