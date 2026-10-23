import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { createIteration, createProduct, createRequirement, createTask, expectNoPageOverflow, json, login, OWNER, setupInstance } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

test('任务编号：甘特与人员负载显示 PAN-T-n，点进任务详情；详情显示字段与「被引用」', async ({ page, request }) => {
  const productId = await createProduct(request);
  const req = await createRequirement(request, productId, '上传提速');
  const iterationId = await createIteration(request, productId, '迭代0105', '2026-01-05', '2026-01-16');
  const me = (await json<{ me: { memberId: string } }>(request.get('/api/v1/orgs/acme'))).me.memberId;
  await createTask(request, { iterationId, requirementId: req.id, title: '前端开发', assigneeMemberId: me, planStart: '2026-01-05', planDays: 2 });
  await createTask(request, { iterationId, title: '联调' });
  await login(page, OWNER.email, OWNER.password);

  await page.goto(`/acme/iterations/${iterationId}?tab=gantt`);
  await expect(page.getByRole('link', { name: 'PAN-T-2' })).toBeVisible();
  await page.getByRole('link', { name: 'PAN-T-1' }).click();
  await expect(page).toHaveURL(/\/acme\/tasks\/PAN-T-1$/);
  const heading = page.getByRole('heading', { level: 1 });
  await expect(heading).toContainText('PAN-T-1');
  await expect(heading).toContainText('前端开发');
  const info = page.getByRole('region', { name: '任务信息' });
  await expect(info).toContainText('上传提速');
  await expect(info).toContainText('迭代0105');
  await expect(info).toContainText(OWNER.name);
  await expect(page.getByRole('region', { name: /被引用/ })).toContainText('还没有被引用');

  await page.goto(`/acme/workload?member=${me}`);
  await expect(page.getByRole('link', { name: 'PAN-T-1' })).toBeVisible();
  await page.goto(`/acme/requirements/${req.displayKey}`);
  await expect(page.getByRole('region', { name: '任务', exact: true }).getByRole('link', { name: /PAN-T-1/ })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/acme');
  const taskRow = page.getByRole('region', { name: /我的任务/ }).getByRole('link', { name: /PAN-T-1/ });
  await expect(taskRow.getByText(req.displayKey, { exact: true })).toBeVisible();
  await expect(taskRow.getByText('迭代0105', { exact: true })).toBeVisible();
  await expect(taskRow.getByText('2026-01-05', { exact: true })).toBeVisible();
});

test('任务不存在时提示；任务详情在 1440 与 760 宽度下不横向滚动', async ({ page, request }) => {
  const productId = await createProduct(request);
  const iterationId = await createIteration(request, productId, '迭代0105', '2026-01-05', '2026-01-16');
  await createTask(request, { iterationId, title: '一个名字很长很长很长很长很长很长很长很长很长很长很长很长很长的任务' });
  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme/tasks/PAN-T-99');
  await expect(page.getByText('任务不存在，或你没有查看它所在产品的权限。')).toBeVisible();
  for (const width of [1440, 760]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/acme/tasks/PAN-T-1');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('PAN-T-1');
    await expectNoPageOverflow(page);
  }
});
