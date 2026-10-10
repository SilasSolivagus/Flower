import { type APIRequestContext, expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { acceptInvite, createDocument, createNode, createProduct, expectNoPageOverflow, FAIL_500, json, launchDocument, login, ok, OWNER, setupInstance } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

const PRD_BODY = '## 背景\n\n现状\n\n## 需求说明\n\n上传改为分片\n\n### 细节\n\n断点续传';

/** 存储/上传/{分片上传, 秒传, 旧接口}、存储/下载/离线下载；上传已有模块文档；PRD 声明四个功能点后上线。 */
async function setup(request: APIRequestContext) {
  const productId = await createProduct(request);
  const storage = await createNode(request, productId, null, '存储');
  const upload = await createNode(request, productId, storage, '上传');
  const chunk = await createNode(request, productId, upload, '分片上传');
  const instant = await createNode(request, productId, upload, '秒传');
  const legacy = await createNode(request, productId, upload, '旧接口');
  const download = await createNode(request, productId, storage, '下载');
  const offline = await createNode(request, productId, download, '离线下载');
  const prd = await createDocument(request, productId, { title: '上传改版' }); // PAN-PRD-1
  await ok(request.put(`/api/v1/orgs/acme/documents/${prd.id}/content`, { data: { baseVersion: prd.version, markdown: PRD_BODY } }));
  const mod = (await json<{ document: { id: string; displayKey: string; version: number } }>(request.post(`/api/v1/orgs/acme/nodes/${upload}/module-document`))).document; // PAN-PRD-2
  await ok(request.put(`/api/v1/orgs/acme/documents/${mod.id}/content`, { data: { baseVersion: mod.version, markdown: '上传总述\n\n## 秒传\n\n秒传说明\n\n## 旧接口\n\n旧接口说明\n' } }));
  const declare = (nodeId: string, changeType: string, sourceSections: string[]) =>
    ok(request.post(`/api/v1/orgs/acme/documents/${prd.id}/affected-nodes`, { data: { nodeId, changeType, sourceSections } }));
  await declare(chunk, 'added', ['需求说明']);
  await declare(instant, 'modified', ['需求说明 / 细节']);
  await declare(legacy, 'removed', []);
  await declare(offline, 'added', []);
  await launchDocument(request, prd.id);
  return { productId, prd, mod, download, chunk };
}

test('合入页：逐个应用与跳过，撤销跳过后再应用；全部处理完 PRD 变为已合入', async ({ page, request }) => {
  const { prd } = await setup(request);
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/documents/${prd.displayKey}`);
  await page.getByRole('complementary').getByRole('link', { name: '合入模块文档' }).click();
  await expect(page).toHaveURL(/\/acme\/documents\/PAN-PRD-1\/merge$/);
  const progress = page.getByRole('status').filter({ hasText: '已处理' });
  await expect(progress).toHaveText('已处理 0 / 4');

  const chunk = page.getByRole('article', { name: '存储/上传/分片上传' });
  await expect(chunk).toContainText('模块文档里还没有这个小节');
  await expect(chunk.getByLabel('分片上传 合入内容')).toHaveValue('上传改为分片\n\n### 细节\n\n断点续传');
  await chunk.getByRole('button', { name: '应用 分片上传' }).click();
  await expect(chunk).toContainText('已应用 · 第 2 版');

  const instant = page.getByRole('article', { name: '存储/上传/秒传' });
  await expect(instant.getByLabel('秒传 现状')).toHaveText('秒传说明');
  await expect(instant.getByLabel('秒传 合入内容')).toHaveValue('断点续传');
  await instant.getByLabel('秒传 合入内容').fill('断点续传，单文件最大 10 GB');
  await instant.getByRole('button', { name: '应用 秒传' }).click();
  await expect(instant).toContainText('已应用');

  const legacy = page.getByRole('article', { name: '存储/上传/旧接口' });
  await expect(legacy).toContainText('应用后将删除该小节');
  await legacy.getByRole('button', { name: '跳过 旧接口' }).click();
  await expect(legacy).toContainText('已跳过');
  await legacy.getByRole('button', { name: '撤销跳过 旧接口' }).click();
  await legacy.getByRole('button', { name: '应用 旧接口' }).click();
  await expect(legacy).toContainText('已应用');

  await expect(page.getByRole('region', { name: '存储/下载' })).toContainText('模块文档将在第一次应用时自动新建');
  const offline = page.getByRole('article', { name: '存储/下载/离线下载' });
  await offline.getByLabel('离线下载 合入内容').fill('支持离线下载');
  // 跳过最后一个即变为已合入；撤销这次跳过退回已上线，再应用
  await offline.getByRole('button', { name: '跳过 离线下载' }).click();
  await expect(progress).toHaveText('已处理 4 / 4，全部处理完，PRD 已变为「已合入」');
  await expect(page.getByText('已合入', { exact: true })).toBeVisible();
  await offline.getByRole('button', { name: '撤销跳过 离线下载' }).click();
  await expect(progress).toHaveText('已处理 3 / 4');
  await expect(page.getByText('已上线', { exact: true })).toBeVisible();
  await expect(offline.getByLabel('离线下载 合入内容')).toHaveValue('支持离线下载');
  await offline.getByRole('button', { name: '应用 离线下载' }).click();
  await expect(progress).toHaveText('已处理 4 / 4，全部处理完，PRD 已变为「已合入」');
  await expect(page.getByRole('region', { name: '存储/下载' }).getByRole('link', { name: 'PAN-PRD-3' })).toBeVisible();

  await page.goto(`/acme/documents/${prd.displayKey}`);
  await expect(page.getByRole('complementary').getByRole('region', { name: '状态' })).toContainText('已合入');
  await expect(page.getByRole('complementary').getByRole('link', { name: '查看合入' })).toBeVisible();
});

test('版本冲突：合入页打开后模块文档被别人改过，应用时提示并刷新左侧后重试', async ({ page, request }) => {
  const { prd, mod } = await setup(request);
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/documents/${prd.displayKey}/merge`);
  const instant = page.getByRole('article', { name: '存储/上传/秒传' });
  await expect(instant.getByLabel('秒传 现状')).toHaveText('秒传说明');
  const cur = await json<{ document: { version: number } }>(request.get(`/api/v1/orgs/acme/documents/${mod.displayKey}`));
  await ok(request.put(`/api/v1/orgs/acme/documents/${mod.id}/content`, { data: { baseVersion: cur.document.version, markdown: '上传总述\n\n## 秒传\n\n别人刚改的秒传说明\n\n## 旧接口\n\n旧接口说明\n' } }));
  await instant.getByLabel('秒传 合入内容').fill('断点续传，改过的合入内容');
  await instant.getByRole('button', { name: '应用 秒传' }).click();
  await expect(instant.getByRole('alert')).toContainText('模块文档已被其他人修改，请刷新左侧内容后重试');
  await instant.getByRole('button', { name: '刷新左侧' }).click();
  await expect(instant.getByLabel('秒传 现状')).toHaveText('别人刚改的秒传说明');
  await expect(instant.getByRole('alert')).toHaveCount(0);
  await expect(instant.getByLabel('秒传 合入内容')).toHaveValue('断点续传，改过的合入内容');
  await instant.getByRole('button', { name: '应用 秒传' }).click();
  await expect(instant).toContainText('已应用');
});

test('模块文档已归档：合入页不显示应用，只能跳过', async ({ page, request }) => {
  const { prd, mod } = await setup(request);
  await ok(request.post(`/api/v1/orgs/acme/documents/${mod.id}/transitions`, { data: { to: 'archived' } }));
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/documents/${prd.displayKey}/merge`);
  const instant = page.getByRole('article', { name: '存储/上传/秒传' });
  await expect(instant).toContainText('模块文档已归档，恢复为使用中后才能应用');
  await expect(instant.getByRole('button', { name: '应用 秒传' })).toHaveCount(0);
  await expect(instant.getByRole('button', { name: '跳过 秒传' })).toBeVisible();
  const offline = page.getByRole('article', { name: '存储/下载/离线下载' });
  await expect(offline.getByRole('button', { name: '应用 离线下载' })).toBeVisible();
  await expect(offline).not.toContainText('模块文档已归档');
});

test('模块文档：合入后的正文、修订来源与合入记录；节点链接跳到模块文档小节或模块文档页签；两种宽度不横向滚动', async ({ page, request }) => {
  const { productId, prd, mod, download } = await setup(request);
  const plan = await json<{ plan: { groups: Array<{ document: { version: number } | null; items: Array<{ nodeId: string; prefill: string }> }> } }>(
    request.get(`/api/v1/orgs/acme/documents/${prd.id}/merge`),
  );
  const up = plan.plan.groups[0]!;
  await ok(request.post(`/api/v1/orgs/acme/documents/${prd.id}/merge/${up.items[0]!.nodeId}/apply`, { data: { baseVersion: up.document!.version, body: up.items[0]!.prefill } }));
  await ok(request.post(`/api/v1/orgs/acme/products/${productId}/requirements`, { data: { title: '引用模块', description: '见 [[存储/上传/分片上传]] 与 [[存储/下载]]' } }));
  await login(page, OWNER.email, OWNER.password);

  await page.goto(`/acme/documents/${mod.displayKey}`);
  const body = page.getByRole('region', { name: '正文' });
  await expect(body.getByRole('heading', { name: '分片上传' })).toBeVisible();
  const revisions = page.getByRole('complementary').getByRole('region', { name: '修订记录' });
  await expect(revisions).toContainText('合入 PAN-PRD-1：分片上传');
  await expect(revisions.getByRole('link', { name: '来源 PAN-PRD-1 上传改版' })).toHaveAttribute('href', `/acme/documents/${prd.displayKey}`);
  const records = page.getByRole('region', { name: '合入记录' });
  await expect(records).toContainText('分片上传');
  await expect(records).toContainText('新增');
  await expect(records.getByRole('link', { name: /PAN-PRD-1/ })).toContainText('上传改版');

  await page.goto('/acme/requirements/PAN-1');
  await page.getByRole('link', { name: '存储/上传/分片上传' }).click();
  await expect(page).toHaveURL(new RegExp(`/acme/documents/${mod.displayKey}\\?section=`));
  await expect(page.getByRole('region', { name: '正文' }).getByRole('heading', { name: '分片上传' })).toBeInViewport();
  await page.goto('/acme/requirements/PAN-1');
  await page.getByRole('link', { name: '存储/下载' }).click();
  await expect(page).toHaveURL(new RegExp(`view=modules&node=${download}`));
  await expect(page.getByRole('row', { name: /^下载/ })).toHaveAttribute('aria-current', 'true');

  for (const width of [1440, 760]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/acme/documents/${prd.displayKey}/merge`);
    await expect(page.getByRole('article', { name: '存储/上传/秒传' })).toBeVisible();
    await expectNoPageOverflow(page);
    await page.goto(`/acme/documents/${mod.displayKey}`);
    await expect(page.getByRole('region', { name: '合入记录' }).getByRole('link', { name: /PAN-PRD-1/ })).toBeVisible();
    await expect(page.getByRole('complementary').getByRole('region', { name: '修订记录' }).getByRole('link', { name: '来源 PAN-PRD-1 上传改版' })).toBeVisible();
    await expectNoPageOverflow(page);
  }
});

test('只读成员能看合入页，没有应用、跳过按钮', async ({ browser, request }) => {
  const { productId, prd } = await setup(request);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const viewerId = await acceptInvite(page, request, { email: 'viewer@example.com', orgRole: 'member', name: '只读成员' });
  await ok(request.put(`/api/v1/orgs/acme/products/${productId}/roles/${viewerId}`, { data: { role: 'viewer' } }));
  await page.goto(`/acme/documents/${prd.displayKey}/merge`);
  const chunk = page.getByRole('article', { name: '存储/上传/分片上传' });
  await expect(chunk.getByLabel('分片上传 合入内容')).toHaveValue('上传改为分片\n\n### 细节\n\n断点续传');
  await expect(page.getByRole('button', { name: /^(应用|跳过) / })).toHaveCount(0);
  await ctx.close();
});

test('合入页加载失败显示重试，重试后恢复', async ({ page, request }) => {
  const { prd } = await setup(request);
  await login(page, OWNER.email, OWNER.password);
  const planUrl = `**/api/v1/orgs/acme/documents/${prd.id}/merge`;
  await page.route(planUrl, (route) => route.fulfill(FAIL_500));
  await page.goto(`/acme/documents/${prd.displayKey}/merge`);
  await expect(page.getByText('加载合入内容失败，请重试。')).toBeVisible({ timeout: 15_000 });
  await page.unroute(planUrl);
  await page.getByRole('button', { name: '重试' }).click();
  await expect(page.getByRole('article', { name: '存储/上传/分片上传' })).toBeVisible();
});
