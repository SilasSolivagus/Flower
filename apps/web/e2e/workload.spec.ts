import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { createIteration, createProduct, createTask, json, login, ok, OWNER, setupInstance } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

test('甘特下方的时间轴与团队负载；点姓名进入人员负载页，跨迭代列出任务，可以包含已结束的迭代', async ({ page, request }) => {
  const productId = await createProduct(request);
  const dev = (await json<{ member: { id: string } }>(request.post('/api/v1/orgs/acme/members', { data: { displayName: '开发乙' } }))).member.id;
  const first = await createIteration(request, productId, '迭代0105', '2026-01-05', '2026-01-16');
  const second = await createIteration(request, productId, '迭代0119', '2026-01-19', '2026-01-30');
  const old = await createIteration(request, productId, '迭代1208', '2025-12-08', '2025-12-19');
  // 01-07 周三开始，工期 2 天、延期 1 天：07、08 为计划内，09 为延期
  await createTask(request, { iterationId: first, title: '接口开发', assigneeMemberId: dev, planStart: '2026-01-07', planDays: 2, delayDays: 1 });
  await createTask(request, { iterationId: second, title: '联调', assigneeMemberId: dev, planStart: '2026-01-19', planDays: 1 });
  await createTask(request, { iterationId: old, title: '旧需求收尾', assigneeMemberId: dev });
  await ok(request.post(`/api/v1/orgs/acme/iterations/${old}/status`, { data: { to: 'active' } }));
  await ok(request.post(`/api/v1/orgs/acme/iterations/${old}/status`, { data: { to: 'done' } }));

  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/iterations/${first}?tab=gantt`);
  const timeline = page.getByRole('region', { name: '时间轴' });
  await expect(timeline).toContainText('接口开发');
  await expect(timeline.locator('[data-kind="plan"]')).toHaveCount(2);
  await expect(timeline.locator('[data-kind="delay"]')).toHaveCount(1);
  const heat = page.getByRole('region', { name: '团队负载' });
  await expect(heat.locator('[data-count="1"]')).toHaveCount(3);
  await heat.getByRole('link', { name: '开发乙' }).click();

  await expect(page).toHaveURL(new RegExp(`/acme/workload\\?member=${dev}$`));
  await expect(page.getByRole('heading', { name: '开发乙 的任务' })).toBeVisible();
  await expect(page.getByRole('region', { name: '迭代0105' })).toContainText('接口开发');
  await expect(page.getByRole('region', { name: '迭代0119' })).toContainText('联调');
  await expect(page.getByText('旧需求收尾')).toHaveCount(0);
  await page.getByRole('switch', { name: '包含已结束的迭代' }).click();
  await expect(page.getByRole('region', { name: '迭代1208' })).toContainText('旧需求收尾');
});

test('迭代列表的「人员负载」入口：选择成员后列出任务', async ({ page, request }) => {
  const productId = await createProduct(request);
  const dev = (await json<{ member: { id: string } }>(request.post('/api/v1/orgs/acme/members', { data: { displayName: '开发乙' } }))).member.id;
  const first = await createIteration(request, productId, '迭代0105', '2026-01-05', '2026-01-16');
  await createTask(request, { iterationId: first, title: '接口开发', assigneeMemberId: dev });

  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme/iterations');
  await page.getByRole('link', { name: '人员负载' }).click();
  await expect(page.getByText('选择一位成员，查看他在各个迭代里的任务。')).toBeVisible();
  await page.getByRole('combobox', { name: '选择成员' }).click();
  await page.getByRole('option', { name: '开发乙' }).click();
  await expect(page.getByRole('region', { name: '迭代0105' })).toContainText('接口开发');
  await expect(page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '迭代', exact: true })).toHaveAttribute('aria-current', 'page');
});
