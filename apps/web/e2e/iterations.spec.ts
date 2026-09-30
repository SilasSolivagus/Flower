import { type APIRequestContext, expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { createProduct, login, ok, OWNER, setupInstance } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

test('迭代列表：新建常规迭代与专项，时间重叠时提示，编辑名称', async ({ page, request }) => {
  await createProduct(request);
  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme');
  await page.getByRole('link', { name: '迭代', exact: true }).click();
  await expect(page).toHaveURL(/\/acme\/iterations$/);
  await expect(page.getByText('还没有迭代')).toBeVisible();

  await page.getByRole('button', { name: '新建迭代' }).click();
  await page.getByLabel('名称', { exact: true }).fill('迭代0701');
  await page.getByLabel('开始日期').fill('2026-07-01');
  await page.getByLabel('结束日期').fill('2026-07-15');
  await page.getByRole('button', { name: '添加里程碑' }).click();
  await page.getByLabel('里程碑 1 名称').fill('发布');
  await page.getByLabel('里程碑 1 日期').fill('2026-07-15');
  await page.getByRole('button', { name: '创建' }).click();
  await expect(page.getByText('已创建迭代')).toBeVisible();
  const pan = page.getByRole('region', { name: '网盘' });
  await expect(pan.getByRole('link', { name: '迭代0701' })).toBeVisible();

  await page.getByRole('button', { name: '新建迭代' }).click();
  await page.getByLabel('名称', { exact: true }).fill('重叠的迭代');
  await page.getByLabel('开始日期').fill('2026-07-10');
  await page.getByLabel('结束日期').fill('2026-07-20');
  await page.getByRole('button', { name: '创建' }).click();
  await expect(page.getByRole('alert').filter({ hasText: '与已有迭代时间重叠' })).toBeVisible();
  await page.getByRole('button', { name: '取消' }).click();

  await page.getByRole('button', { name: '新建迭代' }).click();
  await page.getByRole('combobox', { name: '所属' }).click();
  await page.getByRole('option', { name: '专项（跨产品）' }).click();
  await page.getByLabel('名称', { exact: true }).fill('专业空间优化');
  await page.getByLabel('开始日期').fill('2026-07-01');
  await page.getByLabel('结束日期').fill('2026-09-30');
  await page.getByRole('button', { name: '创建' }).click();
  await expect(page.getByRole('region', { name: '专项' }).getByRole('link', { name: '专业空间优化' })).toBeVisible();

  await pan.getByRole('button', { name: '编辑 迭代0701' }).click();
  await expect(page.getByLabel('名称', { exact: true })).toHaveValue('迭代0701');
  await expect(page.getByLabel('里程碑 1 名称')).toHaveValue('发布');
  await page.getByLabel('名称', { exact: true }).fill('迭代0701-改');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(pan.getByRole('link', { name: '迭代0701-改' })).toBeVisible();
});

test('迭代列表：产品编辑者可以创建常规迭代，但看不到专项选项', async ({ page, request, browser }) => {
  const productId = await createProduct(request);
  const inv = await ok(request.post('/api/v1/orgs/acme/invitations', { data: { email: 'editor@example.com', orgRole: 'member' } }));
  const { token } = (await inv.json()) as { token: string };

  const ctx = await browser.newContext();
  const editorPage = await ctx.newPage();
  await editorPage.goto(`/invite/${token}`);
  await editorPage.getByLabel('你的姓名').fill('编辑者');
  await editorPage.getByLabel('设置密码').fill('password123');
  await editorPage.getByRole('button', { name: '接受邀请' }).click();
  await editorPage.waitForURL('**/acme');

  const members = (await (await ok(request.get('/api/v1/orgs/acme/members'))).json()).members as Array<{ id: string; email: string | null }>;
  const editorMemberId = members.find((m) => m.email === 'editor@example.com')!.id;
  await ok(request.put(`/api/v1/orgs/acme/products/${productId}/roles/${editorMemberId}`, { data: { role: 'editor' } }));

  await editorPage.goto('/acme/iterations');
  await expect(editorPage.getByRole('button', { name: '新建迭代' })).toBeVisible();
  await editorPage.getByRole('button', { name: '新建迭代' }).click();
  await editorPage.getByRole('combobox', { name: '所属' }).click();
  await expect(editorPage.getByRole('option', { name: '专项（跨产品）' })).toHaveCount(0);
  await editorPage.getByRole('option', { name: '网盘（常规迭代）' }).click();
  await editorPage.getByLabel('名称', { exact: true }).fill('编辑者迭代');
  await editorPage.getByLabel('开始日期').fill('2026-08-01');
  await editorPage.getByLabel('结束日期').fill('2026-08-14');
  await editorPage.getByRole('button', { name: '创建' }).click();
  await expect(editorPage.getByText('已创建迭代')).toBeVisible();
  await expect(editorPage.getByRole('region', { name: '网盘' }).getByRole('link', { name: '编辑者迭代' })).toBeVisible();
  await ctx.close();
  await page.close();
});

test('迭代列表：加载失败显示重试', async ({ page }) => {
  await login(page, OWNER.email, OWNER.password);
  await page.route('**/api/v1/orgs/acme/iterations', (route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'internal', message: '服务器错误' } }) }),
  );
  await page.goto('/acme/iterations');
  await expect(page.getByText('加载迭代失败，请重试。')).toBeVisible({ timeout: 15_000 });
  await page.unroute('**/api/v1/orgs/acme/iterations');
  await page.getByRole('button', { name: '重试' }).click();
  await expect(page.getByText('还没有迭代')).toBeVisible();
});

const GATED_WORKFLOW = {
  name: '准入流程',
  body: {
    states: [
      { key: 'backlog', label: '收集', color: '#94a3b8', order: 1, group: '', category: 'backlog' },
      { key: 'done', label: '已上线', color: '#10b981', order: 2, group: '', category: 'completed' },
    ],
    initial: 'backlog',
    transitions: [
      { from: '*', to: 'backlog', conditions: [] },
      { from: '*', to: 'done', conditions: [] },
    ],
    actionGates: [{ action: 'join_iteration', conditions: [{ type: 'check_item', item: 'feasibility', in: ['passed'] }] }],
    checkItems: [{ key: 'feasibility', label: '可行性', scope: 'requirement', type: 'single' }],
  },
};

/** 产品使用带「加入迭代需可行性通过」准入条件的流程；返回产品 id。 */
async function gatedProduct(request: APIRequestContext): Promise<string> {
  const productId = await createProduct(request);
  const wf = await ok(request.post('/api/v1/orgs/acme/workflows', { data: GATED_WORKFLOW }));
  await ok(request.put(`/api/v1/orgs/acme/products/${productId}/workflow`, { data: { versionId: (await wf.json()).version.id } }));
  return productId;
}

async function createRequirement(request: APIRequestContext, productId: string, title: string, feasible: boolean) {
  const r = (await (await ok(request.post(`/api/v1/orgs/acme/products/${productId}/requirements`, { data: { title } }))).json()).requirement;
  if (feasible) await ok(request.put(`/api/v1/orgs/acme/requirements/${r.id}/checks/feasibility`, { data: { state: 'passed' } }));
  return r as { id: string; displayKey: string };
}

test('迭代详情：添加需求、准入条件不满足时强制加入、开始迭代、移出、范围对比', async ({ page, request }) => {
  const productId = await gatedProduct(request);
  await createRequirement(request, productId, '文件夹加密', true);
  await createRequirement(request, productId, '回收站自动清理', false);
  await createRequirement(request, productId, '分享统计', true);
  const iteration = (
    await (
      await ok(
        request.post('/api/v1/orgs/acme/iterations', {
          data: {
            type: 'regular',
            productId,
            name: '迭代0801',
            startDate: '2026-08-01',
            endDate: '2026-08-14',
            milestones: [
              { label: '开发开始', date: '2020-01-01' },
              { label: '发布', date: '2099-12-31' },
            ],
          },
        }),
      )
    ).json()
  ).iteration;

  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/iterations/${iteration.id}`);
  await expect(page.getByRole('heading', { name: '迭代0801' })).toBeVisible();
  const milestones = page.getByRole('list', { name: '里程碑' });
  await expect(milestones.getByRole('listitem').filter({ hasText: '开发开始' })).toContainText('已过');
  await expect(milestones.getByRole('listitem').filter({ hasText: '发布' })).toContainText('未到');

  const add = page.getByRole('textbox', { name: '添加需求' });
  await add.fill('PAN-1');
  await page.getByRole('button', { name: '加入 PAN-1' }).click();
  await expect(page.getByText('已加入迭代')).toBeVisible();
  await expect(page.getByRole('link', { name: '文件夹加密' })).toBeVisible();

  await add.fill('PAN-2');
  await page.getByRole('button', { name: '加入 PAN-2' }).click();
  const alert = page.getByRole('alert').filter({ hasText: '加入迭代的条件未满足' });
  await expect(alert).toContainText('「可行性」需为通过（当前：未开始）');
  await page.getByRole('button', { name: '强制加入 PAN-2' }).click();
  await page.getByLabel('原因').fill('线上问题必须本迭代处理');
  await page.getByRole('button', { name: '确认加入' }).click();
  await expect(page.getByText('已强制加入迭代')).toBeVisible();
  await expect(page.getByRole('link', { name: '回收站自动清理' })).toBeVisible();

  await page.getByRole('button', { name: '开始迭代' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '开始迭代' }).click();
  await expect(page.getByTestId('iteration-status')).toHaveText('进行中');

  await page.getByRole('button', { name: '移出 PAN-2' }).click();
  await expect(page.getByText('已移出迭代')).toBeVisible();
  await add.fill('PAN-3');
  await page.getByRole('button', { name: '加入 PAN-3' }).click();
  await expect(page.getByRole('link', { name: '分享统计' })).toBeVisible();

  await page.getByRole('tab', { name: '范围对比' }).click();
  await expect(page.getByRole('region', { name: '承诺内未完成' })).toContainText('文件夹加密');
  await expect(page.getByRole('region', { name: '中途加入' })).toContainText('分享统计');
  const removed = page.getByRole('region', { name: '中途移出' });
  await expect(removed).toContainText('回收站自动清理');
  await expect(removed).toContainText('未排期');
});

test('迭代详情：不存在时显示无权访问；加载失败（非 404）显示重试', async ({ page, request }) => {
  const productId = await createProduct(request);
  const iteration = (
    await (await ok(request.post('/api/v1/orgs/acme/iterations', { data: { type: 'regular', productId, name: '迭代0901', startDate: '2026-09-01', endDate: '2026-09-14' } }))).json()
  ).iteration;
  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme/iterations/00000000-0000-0000-0000-000000000000');
  await expect(page.getByRole('heading', { name: '无权访问' })).toBeVisible();

  await page.route(`**/api/v1/orgs/acme/iterations/${iteration.id}`, (route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'internal', message: '服务器错误' } }) }),
  );
  await page.goto(`/acme/iterations/${iteration.id}`);
  await expect(page.getByText('加载迭代失败，请重试。')).toBeVisible({ timeout: 15_000 });
  await page.unroute(`**/api/v1/orgs/acme/iterations/${iteration.id}`);
  await page.getByRole('button', { name: '重试' }).click();
  await expect(page.getByRole('heading', { name: '迭代0901' })).toBeVisible();
});

test('发布版本：在迭代详情新建、改计划日期（基线不变）、标记发布；在需求详情关联与解除', async ({ page, request }) => {
  const productId = await createProduct(request);
  const fields = (await (await ok(request.get('/api/v1/orgs/acme/fields'))).json()).fields;
  const platform = fields.find((f: { key: string }) => f.key === 'platform');
  await ok(request.post(`/api/v1/orgs/acme/fields/${platform.id}/options`, { data: { label: 'PC客户端' } }));
  await ok(request.post(`/api/v1/orgs/acme/products/${productId}/requirements`, { data: { title: '分享链接加密码' } }));
  const iteration = (
    await (await ok(request.post('/api/v1/orgs/acme/iterations', { data: { type: 'regular', productId, name: '迭代0801', startDate: '2026-08-01', endDate: '2026-08-14' } }))).json()
  ).iteration;

  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/iterations/${iteration.id}`);
  await page.getByRole('tab', { name: '发布版本' }).click();
  await page.getByRole('button', { name: '新建发布版本' }).click();
  await page.getByLabel('版本号').fill('3.2.0');
  await page.getByRole('combobox', { name: '平台' }).click();
  await page.getByRole('option', { name: 'PC客户端' }).click();
  await page.getByLabel('计划发布日期').fill('2026-08-14');
  await page.getByRole('button', { name: '创建' }).click();
  await expect(page.getByText('已创建发布版本')).toBeVisible();
  const row = page.getByRole('row').filter({ hasText: '3.2.0' });
  await expect(row).toContainText('计划中');

  await row.getByRole('button', { name: '编辑 3.2.0' }).click();
  await page.getByLabel('计划发布日期').fill('2026-08-20');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(row).toContainText('2026-08-20');
  await expect(row).toContainText('2026-08-14');

  await row.getByRole('button', { name: '标记发布 3.2.0' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '标记发布' }).click();
  await expect(row).toContainText('已发布');

  await page.goto('/acme/requirements/PAN-1');
  const releases = page.getByRole('region', { name: '发布版本' });
  await expect(releases).toContainText('未关联');
  await releases.getByRole('combobox', { name: '关联发布版本' }).click();
  await page.getByRole('option', { name: /3\.2\.0/ }).click();
  await expect(page.getByText('已关联版本')).toBeVisible();
  await expect(releases).toContainText('3.2.0');
  await releases.getByRole('button', { name: '解除 3.2.0' }).click();
  await expect(releases).toContainText('未关联');
});
