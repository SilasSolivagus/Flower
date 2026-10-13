import { expect, type Page, test } from '@playwright/test';
import { resetDatabase } from './db';
import {
  acceptInvite,
  createDocument,
  createMember,
  createProduct,
  createRequirement,
  expectNoPageOverflow,
  FAIL_500,
  json,
  login,
  ok,
  OWNER,
  presetTemplateId,
  setupInstance,
} from './helpers';

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

const AUTOSAVE_MS = 1000;
const isSave = (docId: string) => (r: { url(): string; method(): string }) => r.url().endsWith(`/documents/${docId}/content`) && r.method() === 'PUT';

/** 在正文末尾输入一段文字，等自动保存的 PUT 返回。 */
async function typeAtEnd(page: Page, docId: string, text: string) {
  const saved = page.waitForResponse((r) => r.url().endsWith(`/documents/${docId}/content`) && r.request().method() === 'PUT');
  await page.getByRole('region', { name: '正文' }).locator('.bn-block-content').last().click();
  await page.keyboard.press('End');
  await page.keyboard.type(text);
  return saved;
}

test('Flower 文档：输入后自动保存，刷新后仍在', async ({ page, request }) => {
  const productId = await createProduct(request);
  const doc = await createDocument(request, productId, { title: '上传提速', templateId: await presetTemplateId(request, productId) });
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/documents/${doc.displayKey}`);
  const body = page.getByRole('region', { name: '正文' });
  await expect(body).toContainText('1. 背景介绍');
  expect((await typeAtEnd(page, doc.id, '上传失败率降到百分之一以下')).ok()).toBeTruthy();
  await expect(body.getByRole('status')).toHaveText('已保存');
  await page.reload();
  await expect(page.getByRole('region', { name: '正文' })).toContainText('上传失败率降到百分之一以下');
});

test('两个窗口同时编辑：后保存的一方看到冲突提示，重新加载后看到对方的内容', async ({ page, request }) => {
  const productId = await createProduct(request);
  const doc = await createDocument(request, productId, { title: '冲突', templateId: await presetTemplateId(request, productId) });
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/documents/${doc.displayKey}`);
  // 先等甲窗口的编辑器出来再开乙窗口：两个窗口同时首次加载编辑器时，慢机器上会超过断言的等待时间
  await expect(page.getByRole('region', { name: '正文' })).toContainText('1. 背景介绍');
  const other = await page.context().newPage();
  await other.goto(`/acme/documents/${doc.displayKey}`);
  await expect(other.getByRole('region', { name: '正文' })).toContainText('1. 背景介绍');

  expect((await typeAtEnd(page, doc.id, '甲窗口写的')).ok()).toBeTruthy();

  // 乙窗口的保存请求延迟 1.5 秒返回，期间继续输入，让下一次自动保存的定时器在 409 之前就排上
  let puts = 0;
  other.on('request', (r) => {
    if (isSave(doc.id)(r)) puts += 1;
  });
  await other.route(`**/documents/${doc.id}/content`, async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  const conflict = other.waitForResponse((r) => isSave(doc.id)(r.request()));
  await other.getByRole('region', { name: '正文' }).locator('.bn-block-content').last().click();
  await other.keyboard.press('End');
  await other.keyboard.type('乙窗口写的');
  await other.waitForRequest(isSave(doc.id));
  await other.keyboard.type('还在继续写');
  expect((await conflict).status()).toBe(409);
  const alert = other.getByRole('alert').filter({ hasText: '文档已被其他人修改' });
  await expect(alert).toBeVisible();
  // 冲突后自动保存停止：排上的定时器不再发请求，提示一直在，编辑器只读
  await other.waitForTimeout(AUTOSAVE_MS * 2 + 500);
  expect(puts).toBe(1);
  await expect(alert).toBeVisible();
  await expect(other.locator('.bn-editor')).toHaveAttribute('contenteditable', 'false');
  await other.unroute(`**/documents/${doc.id}/content`);
  await alert.getByRole('button', { name: '重新加载' }).click();
  await expect(other.getByRole('region', { name: '正文' })).toContainText('甲窗口写的');
  await expect(other.getByRole('region', { name: '正文' })).not.toContainText('乙窗口写的');
  await expect(other.getByRole('alert').filter({ hasText: '文档已被其他人修改' })).toHaveCount(0);
});

test('改标题后继续编辑正文：自动保存沿用改名后的版本，不报冲突', async ({ page, request }) => {
  const productId = await createProduct(request);
  const doc = await createDocument(request, productId, { title: '改名前', templateId: await presetTemplateId(request, productId) });
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/documents/${doc.displayKey}`);
  const body = page.getByRole('region', { name: '正文' });
  await expect(body).toContainText('1. 背景介绍');

  await page.getByRole('button', { name: /改名前/ }).click();
  const renamed = page.waitForResponse((r) => r.url().endsWith(`/documents/${doc.id}`) && r.request().method() === 'PATCH');
  await page.getByLabel('标题').fill('改名后');
  await page.getByLabel('标题').press('Enter');
  expect((await renamed).ok()).toBeTruthy();
  await expect(page.getByRole('button', { name: /改名后/ })).toBeVisible();

  const saved = await typeAtEnd(page, doc.id, '改名之后写的');
  expect(saved.status()).toBe(200);
  await expect(body.getByRole('status')).toHaveText('已保存');
  await expect(page.getByRole('alert').filter({ hasText: '文档已被其他人修改' })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('region', { name: '正文' })).toContainText('改名之后写的');
});

test('输入后一秒内站内跳走：立即补发保存，回到 PRD 时内容还在', async ({ page, request }) => {
  const productId = await createProduct(request);
  const doc = await createDocument(request, productId, { title: '跳走前', templateId: await presetTemplateId(request, productId) });
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/documents/${doc.displayKey}`);
  await expect(page.getByRole('region', { name: '正文' })).toContainText('1. 背景介绍');

  const saved = page.waitForResponse((r) => isSave(doc.id)(r.request()));
  await page.getByRole('region', { name: '正文' }).locator('.bn-block-content').last().click();
  await page.keyboard.press('End');
  await page.keyboard.type('跳走之前写的');
  await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '文档', exact: true }).click();
  expect((await saved).ok()).toBeTruthy();

  await page.getByRole('link', { name: '跳走前' }).click();
  await expect(page.getByRole('region', { name: '正文' })).toContainText('跳走之前写的');
  await page.reload();
  await expect(page.getByRole('region', { name: '正文' })).toContainText('跳走之前写的');
});

test('保存成功后只更新缓存里的版本号与正文，不重新拉取整篇 PRD', async ({ page, request }) => {
  const productId = await createProduct(request);
  const doc = await createDocument(request, productId, { title: '不重拉', templateId: await presetTemplateId(request, productId) });
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/documents/${doc.displayKey}`);
  const body = page.getByRole('region', { name: '正文' });
  await expect(body).toContainText('1. 背景介绍');
  let detailGets = 0;
  page.on('request', (r) => {
    if (r.method() === 'GET' && r.url().endsWith(`/api/v1/orgs/acme/documents/${doc.displayKey}`)) detailGets += 1;
  });
  const revisions = page.waitForResponse((r) => r.url().endsWith(`/documents/${doc.id}/revisions`) && r.request().method() === 'GET');
  expect((await typeAtEnd(page, doc.id, '只更新缓存')).ok()).toBeTruthy();
  await revisions;
  await expect(body.getByRole('status')).toHaveText('已保存');
  await page.waitForTimeout(500);
  expect(detailGets).toBe(0);
});

test('冲突后重新加载时取数失败：编辑器不重新挂载，冲突提示保留', async ({ page, request }) => {
  const productId = await createProduct(request);
  const doc = await createDocument(request, productId, { title: '重载失败', templateId: await presetTemplateId(request, productId) });
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/documents/${doc.displayKey}`);
  await expect(page.getByRole('region', { name: '正文' })).toContainText('1. 背景介绍');
  await ok(request.put(`/api/v1/orgs/acme/documents/${doc.id}/content`, { data: { baseVersion: 1, markdown: '## 背景\n\n别处写的' } }));
  expect((await typeAtEnd(page, doc.id, '这里写的')).status()).toBe(409);
  const alert = page.getByRole('alert').filter({ hasText: '文档已被其他人修改' });
  await expect(alert).toBeVisible();

  const detail = `**/api/v1/orgs/acme/documents/${doc.displayKey}`;
  let gets = 0;
  await page.route(detail, async (route) => {
    gets += 1;
    await route.fulfill(FAIL_500);
  });
  await alert.getByRole('button', { name: '重新加载' }).click();
  // 查询失败会自动重试两次，等三次请求都失败
  await expect.poll(() => gets, { timeout: 15_000 }).toBe(3);
  await page.waitForTimeout(500);
  await expect(alert).toBeVisible();
  await expect(page.getByRole('region', { name: '正文' })).toContainText('这里写的');

  await page.unroute(detail);
  await alert.getByRole('button', { name: '重新加载' }).click();
  await expect(page.getByRole('region', { name: '正文' })).toContainText('别处写的');
  await expect(page.getByRole('alert').filter({ hasText: '文档已被其他人修改' })).toHaveCount(0);
});

test('刚输入就提交评审：先保存编辑器里的内容，必填小节按最新正文检查', async ({ page, request }) => {
  const productId = await createProduct(request);
  const tpl = await json<{ template: { id: string } }>(
    request.post('/api/v1/orgs/acme/templates', { data: { name: '轻量', body: '## 背景\n\n待填\n', sections: [{ heading: '背景', required: true }] } }),
  );
  const doc = await createDocument(request, productId, { title: '提交前保存', templateId: tpl.template.id });
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/documents/${doc.displayKey}`);
  const body = page.getByRole('region', { name: '正文' });
  // 保存请求晚 1.5 秒才发到服务端：即使自动保存的定时器已经触发，没等它完成就提交评审也会读到旧正文
  await page.route(`**/documents/${doc.id}/content`, async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  await body.getByText('待填').click();
  await page.keyboard.press('End');
  await page.keyboard.type('上传慢');
  const side = page.getByRole('complementary');
  const moved = page.waitForResponse((r) => r.url().endsWith(`/documents/${doc.id}/transitions`));
  await side.getByRole('button', { name: '改为评审中' }).click();
  expect((await moved).status()).toBe(200);
  await expect(side.getByRole('button', { name: '改为评审中' })).toHaveCount(0);
  await expect(side.getByRole('alert')).toHaveCount(0);
  await expect(body.getByRole('status')).toHaveText('已保存');
});

test('保存失败（非冲突）后自动重试一次：重试成功不显示错误，再失败才显示', async ({ page, request }) => {
  const productId = await createProduct(request);
  const doc = await createDocument(request, productId, { title: '重试', templateId: await presetTemplateId(request, productId) });
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/documents/${doc.displayKey}`);
  const body = page.getByRole('region', { name: '正文' });
  await expect(body).toContainText('1. 背景介绍');

  let failures = 1;
  await page.route(`**/documents/${doc.id}/content`, async (route) => {
    if (failures > 0) {
      failures -= 1;
      await route.fulfill(FAIL_500);
    } else await route.continue();
  });
  const retried = page.waitForResponse((r) => isSave(doc.id)(r.request()) && r.status() === 200);
  expect((await typeAtEnd(page, doc.id, '第一次失败')).status()).toBe(500);
  await retried;
  await expect(body.getByRole('status')).toHaveText('已保存');
  await expect(body.getByRole('alert')).toHaveCount(0);

  failures = 2;
  const second = page.waitForResponse((r) => isSave(doc.id)(r.request()) && failures === 0);
  expect((await typeAtEnd(page, doc.id, '两次都失败')).status()).toBe(500);
  expect((await second).status()).toBe(500);
  await expect(body.getByRole('alert')).toContainText('服务器错误');
  await expect(body.getByRole('status')).toHaveText('未保存');
});

test('外部 PRD：链接卡片、改状态、指定负责人、覆盖需求的关联与移出', async ({ page, request }) => {
  const productId = await createProduct(request);
  await createRequirement(request, productId, '分片上传');
  await createMember(request, '产品经理甲');
  const doc = await createDocument(request, productId, { title: '外部方案', externalUrl: 'https://doc.weixin.qq.com/doc/w3_X?scode=1' });
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/documents/${doc.displayKey}`);

  const card = page.getByRole('region', { name: '外部文档' });
  await expect(card).toContainText('企业微信文档');
  await expect(card.getByRole('link', { name: 'https://doc.weixin.qq.com/doc/w3_X?scode=1' })).toHaveAttribute('target', '_blank');
  await expect(page.getByRole('region', { name: '正文' })).toHaveCount(0);

  const side = page.getByRole('complementary');
  await side.getByRole('button', { name: '改为评审中' }).click();
  await expect(side.getByRole('region', { name: '状态' })).toContainText('评审中');
  await expect(side.getByRole('button', { name: '改为已通过' })).toBeVisible();

  await side.getByRole('combobox', { name: '负责人' }).click();
  await page.getByRole('option', { name: '产品经理甲' }).click();
  await expect(side.getByRole('combobox', { name: '负责人' })).toHaveText('产品经理甲');

  const cover = side.getByRole('region', { name: '覆盖的需求' });
  await expect(cover.getByText('还没有覆盖需求')).toBeVisible();
  await cover.getByLabel('需求编号').fill('pan-1');
  await cover.getByRole('button', { name: '关联' }).click();
  await expect(cover.getByRole('link', { name: /PAN-1/ })).toBeVisible();
  await cover.getByRole('button', { name: '移出 PAN-1' }).click();
  await expect(cover.getByText('还没有覆盖需求')).toBeVisible();
});

test('只读成员：编辑器不可编辑，没有改状态按钮；1440 与 760 宽度下页面不横向滚动', async ({ browser, request }) => {
  const productId = await createProduct(request);
  const doc = await createDocument(request, productId, { title: '只读查看', templateId: await presetTemplateId(request, productId) });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const viewerId = await acceptInvite(page, request, { email: 'viewer@example.com', orgRole: 'member', name: '只读成员' });
  await ok(request.put(`/api/v1/orgs/acme/products/${productId}/roles/${viewerId}`, { data: { role: 'viewer' } }));
  for (const width of [1440, 760]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/acme/documents/${doc.displayKey}`);
    await expect(page.getByRole('region', { name: '正文' })).toContainText('1. 背景介绍');
    await expect(page.locator('.bn-editor')).toHaveAttribute('contenteditable', 'false');
    await expect(page.getByRole('complementary').getByRole('region', { name: '状态' })).toContainText('草稿');
    await expect(page.getByRole('button', { name: /^改为/ })).toHaveCount(0);
    await expectNoPageOverflow(page);
  }
  await ctx.close();
});
