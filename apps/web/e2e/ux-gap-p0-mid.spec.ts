import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { acceptInvite, createDocument, createProduct, FAIL_500, json, login, ok, OWNER, setupInstance } from './helpers';

const shots = '/opt/cursor/artifacts';

test.beforeAll(() => {
  mkdirSync(shots, { recursive: true });
});

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

test('M0-015：改为已废弃先确认，取消后仍是草稿', async ({ page, request }) => {
  const productId = await createProduct(request);
  const doc = await createDocument(request, productId, { title: '不要真废弃' });
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/documents/${doc.displayKey}`);
  const status = page.getByRole('region', { name: '状态' });
  await status.getByRole('button', { name: '改为已废弃' }).click();
  const dialog = page.getByRole('dialog', { name: '改为已废弃' });
  await expect(dialog.getByText('改为已废弃后不能恢复。确认后才会改状态。')).toBeVisible();
  await expect(dialog.getByRole('button', { name: '取消' })).toBeFocused();
  await dialog.getByRole('button', { name: '取消' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(status.getByRole('button', { name: '改为评审中' })).toBeVisible();
  await expect(status.getByRole('button', { name: '改为已废弃' })).toBeVisible();
});

test('M0-005/006：产品列表慢网显示加载中，500 显示重试而不是空表', async ({ page, request }) => {
  const productId = await createProduct(request);
  await login(page, OWNER.email, OWNER.password);

  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/v1/orgs/acme/products', async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'GET' && url.pathname.endsWith('/products')) await gate;
    await route.continue();
  });
  await page.goto('/acme/settings/products');
  await expect(page.getByText('加载中').first()).toBeVisible();
  release();
  await expect(page.getByRole('link', { name: '网盘' })).toBeVisible();

  await page.unroute('**/api/v1/orgs/acme/products');
  await page.goto(`/acme/settings/products/${productId}`);
  await expect(page.getByRole('button', { name: '保存' })).toBeDisabled();
  await expect(page.getByText('名称没有变化')).toBeVisible();

  await page.route('**/api/v1/orgs/acme/products', (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'GET' && url.pathname.endsWith('/products')) return route.fulfill(FAIL_500);
    return route.continue();
  });
  await page.goto('/acme/settings/products');
  await expect(page.getByText('加载产品失败，请重试。')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('还没有产品')).toHaveCount(0);
});

test('C3：需求状态主按钮实心，其余放进变更状态菜单', async ({ page, request }) => {
  const productId = await createProduct(request);
  await ok(request.post(`/api/v1/orgs/acme/products/${productId}/requirements`, { data: { title: '状态按钮主次' } }));
  await login(page, OWNER.email, OWNER.password);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/acme/requirements/PAN-1');
  const status = page.getByRole('region', { name: '状态' });
  await expect(status.getByRole('button', { name: '待开始' })).toHaveAttribute('data-emphasis', 'primary');
  await expect(status.getByRole('button', { name: '待开始' })).toBeEnabled();
  for (const label of ['进行中', '已完成', '已取消']) {
    await expect(status.getByRole('button', { name: label })).toHaveCount(0);
  }
  await status.getByRole('button', { name: '变更状态' }).click();
  for (const label of ['进行中', '已完成', '已取消']) {
    const item = page.getByRole('menuitem', { name: new RegExp(`^${label}`) });
    await expect(item).toBeEnabled();
    await expect(item).not.toContainText('现在不能改到这个状态');
  }
  await page.screenshot({ path: `${shots}/ux-gap-requirement-status-1280.png` });
  await page.setViewportSize({ width: 760, height: 900 });
  await page.screenshot({ path: `${shots}/ux-gap-requirement-status-760.png` });
});

test('M0-007：查看者的状态按钮禁用并说明原因', async ({ page, request }) => {
  const productId = await createProduct(request);
  await ok(request.post(`/api/v1/orgs/acme/products/${productId}/requirements`, { data: { title: '只读不能流转' } }));
  const viewerId = await acceptInvite(page, request, { email: 'viewer@example.com', orgRole: 'member', name: '只读成员' });
  await ok(request.put(`/api/v1/orgs/acme/products/${productId}/roles/${viewerId}`, { data: { role: 'viewer' } }));
  await page.goto('/acme/requirements/PAN-1');
  const status = page.getByRole('region', { name: '状态' });
  await expect(status.getByRole('button', { name: '待开始' })).toHaveCount(0);
  await expect(page.getByText('只有编辑可以改状态')).toBeHidden();
  await status.getByRole('button', { name: '变更状态' }).click();
  const blocked = page.getByRole('menuitem', { name: /^待开始/ });
  await expect(blocked).toHaveAttribute('aria-disabled', 'true');
  await expect(blocked).toContainText('只有编辑可以改状态');
});

test('M6-013：工作项详情和窄列表显示预计日，空为未设置，过期弱提示', async ({ page, request }) => {
  await createProduct(request);
  const overdue = await json<{ workItem: { displayKey: string } }>(
    request.post('/api/v1/orgs/acme/work-items', { data: { title: '逾期工作项', expectedDate: '2026-10-01' } }),
  );
  const empty = await json<{ workItem: { displayKey: string } }>(request.post('/api/v1/orgs/acme/work-items', { data: { title: '未定期限' } }));
  await login(page, OWNER.email, OWNER.password);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/acme/work-items/${overdue.workItem.displayKey}`);
  const date = page.getByRole('region', { name: '基本信息' }).getByTestId('expected-date');
  await expect(date).toContainText('2026-10-01');
  await expect(date).toContainText('已逾期');
  await expect(date).toHaveClass(/amber/);
  await expect(date).not.toHaveClass(/destructive/);
  await page.screenshot({ path: `${shots}/ux-gap-work-item-1280.png` });
  await page.setViewportSize({ width: 760, height: 900 });
  await page.screenshot({ path: `${shots}/ux-gap-work-item-760.png` });

  await page.goto(`/acme/work-items/${empty.workItem.displayKey}`);
  await expect(page.getByRole('region', { name: '基本信息' }).getByTestId('expected-date')).toHaveText('未设置');

  await page.goto('/acme/tracking');
  const narrow = page.getByRole('list', { name: '全部在手' });
  await expect(narrow.getByText('未设置')).toBeVisible();
  const overdueMark = narrow.getByText('已逾期');
  await overdueMark.scrollIntoViewIfNeeded();
  await expect(overdueMark).toBeVisible();
  await page.screenshot({ path: `${shots}/ux-gap-tracking-760.png` });
});
