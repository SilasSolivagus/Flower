import { expect, test } from '@playwright/test';
import { Document, HeadingLevel, ImageRun, Packer, Paragraph } from 'docx';
import { resetDatabase } from './db';
import { createDocument, createProduct, json, login, OWNER, PNG_1PX_BASE64 as PNG_B64, setupInstance } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

test('外部 PRD 上传 Markdown 转为 Flower 文档，原链接保留', async ({ page, request }) => {
  const productId = await createProduct(request);
  const doc = await createDocument(request, productId, { title: '飞书方案', externalUrl: 'https://abc.feishu.cn/docx/1' });
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/documents/${doc.displayKey}`);
  await page.getByRole('region', { name: '外部文档' }).getByRole('button', { name: '转为 Flower 文档' }).click();
  const dialog = page.getByRole('dialog', { name: '转为 Flower 文档' });
  await dialog.getByRole('tab', { name: 'Markdown 文件' }).click();
  await dialog.getByLabel('选择 Markdown 文件').setInputFiles({ name: 'prd.md', mimeType: 'text/markdown', buffer: Buffer.from('## 背景\n\n从 Markdown 导入\n\n## 需求\n\n- 分片上传') });
  await expect(dialog.getByRole('region', { name: '导入预览' })).toContainText('2 个小节');
  await dialog.getByRole('button', { name: '确认导入' }).click();
  await expect(page.getByRole('region', { name: '正文' })).toContainText('从 Markdown 导入');
  await expect(page.getByRole('region', { name: '外部文档' })).toHaveCount(0);
  await expect(page.getByRole('complementary')).toContainText('原链接');
  await expect(page.getByRole('complementary').getByRole('region', { name: '修订记录' })).toContainText('由外部文档转换');
});

test('新建时选「导入」，上传 Word：标题、正文与图片都进入 Flower 文档，图片转存为附件', async ({ page, request }) => {
  await createProduct(request);
  const buffer = await Packer.toBuffer(
    new Document({
      sections: [
        {
          children: [
            new Paragraph({ text: '背景', heading: HeadingLevel.HEADING_2 }),
            new Paragraph('从 Word 导入的正文'),
            new Paragraph({ children: [new ImageRun({ type: 'png', data: Buffer.from(PNG_B64, 'base64'), transformation: { width: 10, height: 10 } })] }),
          ],
        },
      ],
    }),
  );
  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme/documents');
  await page.getByRole('button', { name: '新建 PRD' }).click();
  const create = page.getByRole('dialog', { name: '新建 PRD' });
  await create.getByRole('tab', { name: '导入' }).click();
  await create.getByLabel('标题').fill('Word 导入');
  await create.getByRole('button', { name: '创建' }).click();
  await page.waitForURL(/\/acme\/documents\/PAN-PRD-1\?import=1$/);

  const dialog = page.getByRole('dialog', { name: '导入内容' });
  await dialog.getByRole('tab', { name: 'Word 文件' }).click();
  await dialog.getByLabel('选择 Word 文件').setInputFiles({ name: 'prd.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer });
  await expect(dialog.getByRole('region', { name: '导入预览' })).toContainText('1 张图片将上传为附件');
  const uploaded = page.waitForResponse((r) => r.url().includes('/attachments') && r.request().method() === 'POST');
  await dialog.getByRole('button', { name: '确认导入' }).click();
  expect((await uploaded).status()).toBe(201);
  const body = page.getByRole('region', { name: '正文' });
  await expect(body).toContainText('从 Word 导入的正文');
  await expect(body.locator('img[src*="/attachments/"]')).toHaveCount(1);
  await expect(page).not.toHaveURL(/import=1/);
});

test('粘贴：保留标题与表格，内嵌图片上传，外部图片保留链接', async ({ page, request }) => {
  const productId = await createProduct(request);
  const doc = await createDocument(request, productId, { title: '粘贴方案', externalUrl: 'https://doc.weixin.qq.com/doc/w3_P' });
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/documents/${doc.displayKey}`);
  await page.getByRole('button', { name: '转为 Flower 文档' }).click();
  const dialog = page.getByRole('dialog', { name: '转为 Flower 文档' });
  const html = `<h2>背景</h2><p>从网页粘贴的内容</p><table><tr><th>字段</th><th>说明</th></tr><tr><td>大小</td><td>上限 10 GB</td></tr></table><p><img src="data:image/png;base64,${PNG_B64}"></p><p><img src="https://wdcdn.qpic.cn/x.png"></p>`;
  await dialog.getByRole('textbox', { name: '粘贴区域' }).evaluate((el, content) => {
    const dt = new DataTransfer();
    dt.setData('text/html', content);
    dt.setData('text/plain', '从网页粘贴的内容');
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, html);
  const preview = dialog.getByRole('region', { name: '导入预览' });
  await expect(preview).toContainText('1 张图片将上传为附件');
  await expect(preview).toContainText('1 张外部图片保留原链接');
  await dialog.getByRole('button', { name: '确认导入' }).click();
  const body = page.getByRole('region', { name: '正文' });
  await expect(body).toContainText('从网页粘贴的内容');
  await expect(body).toContainText('上限 10 GB');
  await expect(body.locator('img[src*="/attachments/"]')).toHaveCount(1);
});

test('编辑器里粘贴含内嵌图片的网页内容：图片先转存为附件，自动保存成功，正文不含 data:', async ({ page, request }) => {
  const productId = await createProduct(request);
  const doc = await createDocument(request, productId, { title: '粘贴图片' });
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/documents/${doc.displayKey}`);
  const body = page.getByRole('region', { name: '正文' });
  await body.locator('.bn-block-content').first().click();
  const uploaded = page.waitForResponse((r) => r.url().endsWith(`/documents/${doc.id}/attachments`) && r.request().method() === 'POST');
  const saved = page.waitForResponse((r) => r.url().endsWith(`/documents/${doc.id}/content`) && r.request().method() === 'PUT');
  await body.locator('[contenteditable="true"]').first().evaluate((el, b64) => {
    const dt = new DataTransfer();
    dt.setData('text/html', `<p>粘贴的截图</p><p><img src="data:image/png;base64,${b64}"></p>`);
    dt.setData('text/plain', '粘贴的截图');
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, PNG_B64);
  expect((await uploaded).status()).toBe(201);
  expect((await saved).status()).toBe(200);
  await expect(body.getByRole('status')).toHaveText('已保存');
  const stored = await json<{ document: { markdown: string } }>(request.get(`/api/v1/orgs/acme/documents/${doc.displayKey}`));
  expect(stored.document.markdown).toMatch(/!\[[^\]]*\]\(\/api\/v1\/orgs\/acme\/attachments\/[^)]+\)/);
  expect(stored.document.markdown).not.toContain('data:');
});
