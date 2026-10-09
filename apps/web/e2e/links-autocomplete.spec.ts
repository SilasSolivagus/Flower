import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { createDocument, createProduct, createRequirement, login, ok, OWNER, setupInstance } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

test('需求描述：输入 [[ 弹出补全，按标题搜索、回车插入；Esc 关闭；保存后显示链接卡', async ({ page, request }) => {
  const productId = await createProduct(request);
  await createRequirement(request, productId, '登录改版');
  const src = await createRequirement(request, productId, '引用方');
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/requirements/${src.displayKey}`);
  const desc = page.getByRole('region', { name: '描述' });
  await desc.getByRole('button', { name: '编辑' }).click();
  const input = desc.getByRole('textbox', { name: '描述' });
  await input.click();
  await page.keyboard.type('依赖 [[登录');
  const list = page.getByRole('listbox', { name: '链接补全' });
  // 等防抖查询结算为「登录」：期间列表可能先显示防抖前的默认建议（本产品最近更新的需求），故先等列表收敛到唯一一条再按回车
  await expect(list.getByRole('option')).toHaveCount(1);
  await expect(list.getByRole('option', { name: /PAN-1.*登录改版/ })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(input).toHaveValue('依赖 [[PAN-1]]');
  await expect(list).toBeHidden();
  await page.keyboard.type(' 和 [[');
  await expect(list).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(list).toBeHidden();
  await input.fill('依赖 [[PAN-1]]');
  await desc.getByRole('button', { name: '保存' }).click();
  await expect(desc.getByRole('link', { name: 'PAN-1 登录改版 待处理' })).toBeVisible();
});

test('需求评论：选中 PRD 后继续选小节，上下键选择；发表后显示链接卡', async ({ page, request }) => {
  const productId = await createProduct(request);
  const req = await createRequirement(request, productId, '登录改版');
  const doc = await createDocument(request, productId, { title: '登录 PRD' });
  await ok(request.put(`/api/v1/orgs/acme/documents/${doc.id}/content`, { data: { baseVersion: doc.version, markdown: '## 1. 背景\n\n现状\n\n## 2. 需求说明\n\n内容' } }));
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/requirements/${req.displayKey}`);
  const comments = page.getByRole('region', { name: /^评论/ });
  const input = comments.getByRole('textbox', { name: '写评论' });
  await input.click();
  await page.keyboard.type('PRD 见 [[PAN-PRD');
  const list = page.getByRole('listbox', { name: '链接补全' });
  // 同上：等防抖查询结算为「PAN-PRD」后列表收敛到唯一一条再按回车
  await expect(list.getByRole('option')).toHaveCount(1);
  await expect(list.getByRole('option', { name: /PAN-PRD-1.*登录 PRD/ })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(input).toHaveValue('PRD 见 [[PAN-PRD-1#');
  await expect(list.getByRole('option', { name: /整篇/ })).toBeVisible();
  await expect(list.getByRole('option')).toHaveCount(3);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(input).toHaveValue('PRD 见 [[PAN-PRD-1#需求说明]]');
  await comments.getByRole('button', { name: '发表' }).click();
  await expect(comments.getByRole('link', { name: 'PAN-PRD-1#需求说明 登录 PRD 草稿' })).toBeVisible();
});

test('PRD 评论区的输入框同样支持 [[ 补全', async ({ page, request }) => {
  const productId = await createProduct(request);
  await createRequirement(request, productId, '登录改版');
  const doc = await createDocument(request, productId, { title: '登录 PRD' });
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/documents/${doc.displayKey}`);
  const input = page.getByRole('region', { name: /^评论/ }).getByRole('textbox', { name: '发表评论' });
  await input.click();
  await page.keyboard.type('对应 [[PAN-1');
  await expect(page.getByRole('listbox', { name: '链接补全' }).getByRole('option', { name: /PAN-1.*登录改版/ })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(input).toHaveValue('对应 [[PAN-1]]');
});

test('划词评论对话框：输入 [[ 弹出补全，Esc 只关闭补全列表，对话框仍打开', async ({ page, request }) => {
  const productId = await createProduct(request);
  await createRequirement(request, productId, '登录改版');
  const doc = await createDocument(request, productId, { title: '登录 PRD' });
  await ok(request.put(`/api/v1/orgs/acme/documents/${doc.id}/content`, { data: { baseVersion: doc.version, markdown: '正文内容在这里' } }));
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/documents/${doc.displayKey}`);
  await page.getByRole('region', { name: '正文' }).getByText('正文内容在这里').click({ clickCount: 3 });
  await page.getByRole('button', { name: '评论', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '评论选中的文字' });
  const input = dialog.getByRole('textbox', { name: '评论内容' });
  await input.click();
  await page.keyboard.type('见 [[登录');
  const list = page.getByRole('listbox', { name: '链接补全' });
  await expect(list.getByRole('option', { name: /PAN-1.*登录改版/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(list).toBeHidden();
  await expect(dialog).toBeVisible();
});
