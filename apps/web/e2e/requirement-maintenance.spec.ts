import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { createProduct, createRequirement, json, login, ok, OWNER, setupInstance } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

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

test('需求详情：新增与解除阻塞项；迭代需求页签显示阻塞标记', async ({ page, request }) => {
  const productId = await createProduct(request);
  const req = await createRequirement(request, productId, '上传断点续传');
  const iteration = (
    await json<{ iteration: { id: string } }>(
      request.post('/api/v1/orgs/acme/iterations', { data: { type: 'regular', productId, name: '迭代0801', startDate: '2026-08-01', endDate: '2026-08-14' } }),
    )
  ).iteration;
  await ok(request.put(`/api/v1/orgs/acme/requirements/${req.id}/iteration`, { data: { iterationId: iteration.id } }));

  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme/requirements/PAN-1');
  const blockers = page.getByRole('region', { name: '阻塞项' });
  await blockers.getByLabel('新阻塞项').fill('等待存储接口');
  await blockers.getByRole('button', { name: '添加' }).click();
  await expect(page.getByText('已添加阻塞项')).toBeVisible();
  await expect(blockers).toContainText('等待存储接口');

  await page.goto(`/acme/iterations/${iteration.id}`);
  await expect(page.getByRole('row').filter({ hasText: '上传断点续传' }).getByTestId('blocker-badge')).toHaveText('1');

  await page.goto('/acme/requirements/PAN-1');
  await blockers.getByRole('button', { name: '解除：等待存储接口' }).click();
  await expect(page.getByText('已解除', { exact: true })).toBeVisible();
  await expect(blockers).toContainText('没有未解除的阻塞项');
  await expect(blockers.getByText('已解除 1 条')).toBeVisible();
});

test('需求详情：按编号或标题添加关联（含其他产品），显示方向，重复时提示，删除', async ({ page, request }) => {
  const pan = await createProduct(request);
  await createRequirement(request, pan, '上传断点续传');
  await createRequirement(request, pan, '下载断点续传');
  const doc = await createProduct(request, '文档', 'DOC');
  await createRequirement(request, doc, '文档导出');

  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme/requirements/PAN-1');
  const relations = page.getByRole('region', { name: '关联需求' });
  await relations.getByRole('combobox', { name: '关联类型' }).click();
  await page.getByRole('option', { name: '阻塞' }).click();
  await relations.getByLabel('搜索要关联的需求').fill('下载');
  await relations.getByRole('button', { name: '关联 PAN-2' }).click();
  await expect(page.getByText('已添加关联')).toBeVisible();
  await expect(relations).toContainText('阻塞了 PAN-2');

  await relations.getByRole('combobox', { name: '关联类型' }).click();
  await page.getByRole('option', { name: '相关' }).click();
  await relations.getByLabel('搜索要关联的需求').fill('doc-1');
  await relations.getByRole('button', { name: '关联 DOC-1' }).click();
  await expect(relations).toContainText('DOC-1');

  await relations.getByLabel('搜索要关联的需求').fill('DOC-1');
  await relations.getByRole('button', { name: '关联 DOC-1' }).click();
  await expect(relations.getByRole('alert').filter({ hasText: '已存在相同的关联' })).toBeVisible();

  await page.goto('/acme/requirements/PAN-2');
  await expect(page.getByRole('region', { name: '关联需求' })).toContainText('被 PAN-1 阻塞');

  await page.goto('/acme/requirements/PAN-1');
  await relations.getByRole('button', { name: '删除与 PAN-2 的关联' }).click();
  await expect(page.getByText('已删除关联')).toBeVisible();
  await expect(relations).not.toContainText('PAN-2');
});
