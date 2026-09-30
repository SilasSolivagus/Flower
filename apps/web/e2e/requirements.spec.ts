import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { createMember, createProduct, FAIL_500, login, ok, OWNER, setupInstance } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

test('需求列表：新建、按状态和优先级筛选、搜索编号', async ({ page, request }) => {
  const productId = await createProduct(request);
  const fields = (await (await ok(request.get('/api/v1/orgs/acme/fields'))).json()).fields;
  const p0 = fields.find((f: { key: string }) => f.key === 'priority').options.find((o: { key: string }) => o.key === 'p0').id;
  await ok(request.post(`/api/v1/orgs/acme/products/${productId}/requirements`, { data: { title: '回收站保留 30 天', fields: { priority: [p0] } } }));

  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme/requirements');
  await expect(page.getByRole('heading', { name: '需求' })).toBeVisible();
  await expect(page.getByRole('tab', { name: /全部/ })).toContainText('1');

  await page.getByRole('button', { name: '新建需求' }).click();
  await page.getByLabel('标题').fill('分享链接支持设置密码');
  await page.getByRole('combobox', { name: '优先级' }).click();
  await page.getByRole('option', { name: 'P1' }).click();
  await page.getByRole('button', { name: '创建' }).click();
  await expect(page.getByText('已创建 PAN-2')).toBeVisible();
  await expect(page.getByRole('link', { name: '分享链接支持设置密码' })).toBeVisible();
  await expect(page.getByRole('tab', { name: /全部/ })).toContainText('2');

  await page.getByRole('button', { name: /^优先级/ }).click();
  await page.getByRole('checkbox', { name: 'P0' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('link', { name: '回收站保留 30 天' })).toBeVisible();
  await expect(page.getByRole('link', { name: '分享链接支持设置密码' })).toHaveCount(0);
  await expect(page).toHaveURL(/priority=/);

  await page.goto('/acme/requirements');
  await page.getByLabel('搜索需求').fill('PAN-2');
  await expect(page.getByRole('link', { name: '分享链接支持设置密码' })).toBeVisible();
  await expect(page.getByRole('link', { name: '回收站保留 30 天' })).toHaveCount(0);

  await page.goto('/acme/requirements');
  await page.getByRole('tab', { name: /待开始/ }).click();
  await expect(page.getByText('没有符合条件的需求')).toBeVisible();
});

test('搜索框防抖期间切换其他筛选不丢失已输入的文字', async ({ page, request }) => {
  const productId = await createProduct(request);
  const fields = (await (await ok(request.get('/api/v1/orgs/acme/fields'))).json()).fields;
  const p0 = fields.find((f: { key: string }) => f.key === 'priority').options.find((o: { key: string }) => o.key === 'p0').id;
  await ok(request.post(`/api/v1/orgs/acme/products/${productId}/requirements`, { data: { title: '回收站保留 30 天', fields: { priority: [p0] } } }));

  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme/requirements');
  await page.getByLabel('搜索需求').fill('回收站');
  await page.getByRole('button', { name: /^优先级/ }).click();
  await page.getByRole('checkbox', { name: 'P0' }).click();
  await page.keyboard.press('Escape');

  await expect(page).toHaveURL(/q=/);
  await expect(page).toHaveURL(/priority=/);
  await expect(page.getByLabel('搜索需求')).toHaveValue('回收站');
});

test('导航中的"需求"可以点击', async ({ page, request }) => {
  await createProduct(request);
  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme');
  await page.getByRole('link', { name: '需求' }).click();
  await expect(page).toHaveURL(/\/acme\/requirements/);
});

test('需求详情：看到卡在哪、设置检查项后流转、强制流转、评论', async ({ page, request }) => {
  const productId = await createProduct(request);
  const wf = await ok(request.post('/api/v1/orgs/acme/workflows', {
    data: {
      name: '评审流程',
      body: {
        states: [
          { key: 'backlog', label: '收集', color: '#94a3b8', order: 1, group: '', category: 'backlog' },
          { key: 'todo', label: '待开发', color: '#60a5fa', order: 2, group: '', category: 'unstarted' },
          { key: 'doing', label: '开发中', color: '#f59e0b', order: 3, group: '', category: 'started' },
        ],
        initial: 'backlog',
        transitions: [
          { from: '*', to: 'todo', conditions: [{ type: 'check_item', item: 'feasibility', in: ['passed'] }] },
          { from: '*', to: 'doing', conditions: [{ type: 'has_iteration' }] },
          { from: '*', to: 'backlog', conditions: [] },
        ],
        checkItems: [{ key: 'feasibility', label: '可行性', scope: 'requirement', type: 'single' }],
      },
    },
  }));
  const versionId = (await wf.json()).version.id;
  await ok(request.put(`/api/v1/orgs/acme/products/${productId}/workflow`, { data: { versionId } }));
  await ok(request.post(`/api/v1/orgs/acme/products/${productId}/requirements`, { data: { title: '文件夹支持拖拽排序' } }));

  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme/requirements/PAN-1');
  await expect(page.getByTestId('current-state')).toHaveText('收集');
  await expect(page.getByRole('button', { name: '待开发' })).toBeDisabled();
  await expect(page.getByText('「可行性」需为通过（当前：未开始）')).toBeVisible();

  await page.getByRole('combobox', { name: '可行性状态' }).click();
  await page.getByRole('option', { name: '通过' }).click();
  await expect(page.getByRole('button', { name: '待开发' })).toBeEnabled();
  await page.getByRole('button', { name: '待开发' }).click();
  await expect(page.getByTestId('current-state')).toHaveText('待开发');

  await expect(page.getByText('需要先加入迭代')).toBeVisible();
  await page.getByRole('button', { name: '强制流转' }).click();
  await page.getByLabel('原因').fill('线上问题紧急修复');
  await page.getByRole('button', { name: '确认流转' }).click();
  await expect(page.getByTestId('current-state')).toHaveText('开发中');
  const history = page.getByRole('region', { name: '状态历史' });
  await expect(history.getByText('强制')).toBeVisible();
  await expect(history.getByText('原因：线上问题紧急修复')).toBeVisible();

  await page.getByLabel('写评论').fill('已和设计确认交互');
  await page.getByRole('button', { name: '发表' }).click();
  await expect(page.getByRole('region', { name: /评论/ }).getByText('已和设计确认交互')).toBeVisible();
});

test('需求详情：加载失败（非 404）显示提示，重试后恢复', async ({ page, request }) => {
  const productId = await createProduct(request);
  await ok(request.post(`/api/v1/orgs/acme/products/${productId}/requirements`, { data: { title: '加载失败重试用例' } }));

  await login(page, OWNER.email, OWNER.password);
  await page.route('**/api/v1/orgs/acme/requirements/PAN-1', (route) => route.fulfill(FAIL_500));
  await page.goto('/acme/requirements/PAN-1');
  await expect(page.getByText('加载需求失败，请重试。')).toBeVisible();

  await page.unroute('**/api/v1/orgs/acme/requirements/PAN-1');
  await page.getByRole('button', { name: '重试' }).click();
  await expect(page.getByText('加载失败重试用例')).toBeVisible();
});

test('需求详情：本人签字与管理员代签', async ({ page, request }) => {
  const productId = await createProduct(request);
  const members = (await (await ok(request.get('/api/v1/orgs/acme/members'))).json()).members as Array<{ id: string; displayName: string }>;
  const ownerId = members.find((m) => m.displayName === OWNER.name)!.id;
  const designer = await createMember(request, '设计师丙');
  const wf = await ok(
    request.post('/api/v1/orgs/acme/workflows', {
      data: {
        name: '签字流程',
        body: {
          states: [{ key: 'backlog', label: '收集', color: '#94a3b8', order: 1, group: '', category: 'backlog' }],
          initial: 'backlog',
          checkItems: [
            {
              key: 'design_signoff',
              label: '设计签字',
              scope: 'requirement',
              type: 'signoff',
              signers: [
                { by: 'member', ref: ownerId },
                { by: 'member', ref: designer },
              ],
              signoffRule: 'all',
            },
          ],
        },
      },
    }),
  );
  await ok(request.put(`/api/v1/orgs/acme/products/${productId}/workflow`, { data: { versionId: (await wf.json()).version.id } }));
  await ok(request.post(`/api/v1/orgs/acme/products/${productId}/requirements`, { data: { title: '会员中心改版' } }));

  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme/requirements/PAN-1');
  const item = page.getByRole('listitem', { name: '设计签字' });
  await item.getByRole('button', { name: '通过' }).click();
  await expect(item.getByText(`通过 · ${OWNER.name}`)).toBeVisible();

  await item.getByRole('button', { name: '代签' }).click();
  await page.getByLabel('备注').fill('电话确认');
  await page.getByRole('button', { name: '确认代签' }).click();
  await expect(item.getByText(`（由 ${OWNER.name} 代签）`)).toBeVisible();
  await expect(item.getByText('通过 · 设计师丙')).toBeVisible();
});

test('需求详情：编号不存在时显示无权限/不存在提示', async ({ page, request }) => {
  await createProduct(request);
  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme/requirements/PAN-99');
  await expect(page.getByText('需求不存在，或你没有查看它所在产品的权限。')).toBeVisible();
});

test('需求列表：加载失败显示提示，重试后恢复', async ({ page, request }) => {
  const productId = await createProduct(request);
  await ok(request.post(`/api/v1/orgs/acme/products/${productId}/requirements`, { data: { title: '列表重试用例' } }));

  await login(page, OWNER.email, OWNER.password);
  const listUrl = `**/api/v1/orgs/acme/products/${productId}/requirements?*`;
  await page.route(listUrl, (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'internal', message: '服务器错误' } }) }));
  await page.goto('/acme/requirements');
  await expect(page.getByText('加载需求列表失败，请重试。')).toBeVisible({ timeout: 15_000 });

  await page.unroute(listUrl);
  await page.getByRole('button', { name: '重试' }).click();
  await expect(page.getByRole('link', { name: '列表重试用例' })).toBeVisible();
});
