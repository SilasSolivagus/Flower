import { type APIRequestContext, type APIResponse, expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { createProduct, login, ok, OWNER, setupInstance } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

async function json<T>(pending: Promise<APIResponse>): Promise<T> {
  return (await (await ok(pending)).json()) as T;
}

async function createRequirement(request: APIRequestContext, productId: string, title: string) {
  return (await json<{ requirement: { id: string; displayKey: string } }>(request.post(`/api/v1/orgs/acme/products/${productId}/requirements`, { data: { title } })))
    .requirement;
}

test('需求详情：加入迭代的条件未满足时显示原因，管理员强制加入；结构节点可选任意层级', async ({ page, request }) => {
  const productId = await createProduct(request);
  const wf = await json<{ version: { id: string } }>(
    request.post('/api/v1/orgs/acme/workflows', {
      data: {
        name: '准入流程',
        body: {
          states: [{ key: 'backlog', label: '收集', color: '#94a3b8', order: 1, group: '', category: 'backlog' }],
          initial: 'backlog',
          transitions: [{ from: '*', to: 'backlog', conditions: [] }],
          actionGates: [{ action: 'join_iteration', conditions: [{ type: 'check_item', item: 'feasibility', in: ['passed'] }] }],
          checkItems: [{ key: 'feasibility', label: '可行性', scope: 'requirement', type: 'single' }],
        },
      },
    }),
  );
  await ok(request.put(`/api/v1/orgs/acme/products/${productId}/workflow`, { data: { versionId: wf.version.id } }));
  await createRequirement(request, productId, '分享链接有效期');
  await ok(request.post('/api/v1/orgs/acme/iterations', { data: { type: 'regular', productId, name: '迭代0801', startDate: '2026-08-01', endDate: '2026-08-14' } }));
  const root = (await json<{ node: { id: string } }>(request.post(`/api/v1/orgs/acme/products/${productId}/nodes`, { data: { name: '会员与支付' } }))).node;
  await ok(request.post(`/api/v1/orgs/acme/products/${productId}/nodes`, { data: { parentId: root.id, name: '续费' } }));
  const old = (await json<{ node: { id: string } }>(request.post(`/api/v1/orgs/acme/products/${productId}/nodes`, { data: { name: '旧业务' } }))).node;
  await ok(request.patch(`/api/v1/orgs/acme/nodes/${old.id}`, { data: { status: 'deprecated' } }));

  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme/requirements/PAN-1');
  await expect(page.getByRole('list', { name: '加入迭代的条件' })).toContainText('「可行性」需为通过（当前：未开始）');

  await page.getByRole('combobox', { name: '迭代' }).click();
  await page.getByRole('option', { name: '迭代0801' }).click();
  await expect(page.getByRole('alert').filter({ hasText: '加入迭代的条件未满足' })).toBeVisible();
  await page.getByRole('button', { name: '强制加入' }).click();
  await page.getByLabel('原因').fill('客户合同要求本迭代交付');
  await page.getByRole('button', { name: '确认加入' }).click();
  await expect(page.getByText('已强制加入迭代')).toBeVisible();
  await expect(page.getByRole('combobox', { name: '迭代' })).toHaveText('迭代0801');

  await page.getByRole('combobox', { name: '结构节点' }).click();
  await expect(page.getByRole('option', { name: '续费' })).toBeVisible();
  await expect(page.getByRole('option', { name: '旧业务' })).toHaveCount(0);
  await page.getByRole('option', { name: '续费' }).click();
  await expect(page.getByRole('combobox', { name: '结构节点' })).toHaveText('续费');

  await page.getByRole('combobox', { name: '迭代' }).click();
  await page.getByRole('option', { name: '未排期' }).click();
  await expect(page.getByRole('combobox', { name: '迭代' })).toHaveText('未排期');
});
