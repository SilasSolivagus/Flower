import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { applyReviewWorkflow, createIteration, createMember, createProduct, createRequirement, expectNoPageOverflow, json, login, ok, OWNER, setupInstance } from './helpers';

const LONG = '一个很长的需求标题，用来检查窄屏下表格与卡片不会把页面撑宽，也不会把标题挤没';
const WIDTHS = [1440, 800];

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

test('成员页：页面不横向滚动，成员抽屉完整显示在视口内', async ({ page, request }) => {
  await createProduct(request);
  await createMember(request, '王总');
  await login(page, OWNER.email, OWNER.password);
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/acme/settings/members');
    await expect(page.getByRole('row', { name: /王总/ })).toBeVisible();
    await expectNoPageOverflow(page);
    await page.getByRole('button', { name: '查看王总' }).click();
    await expect(page.getByRole('dialog', { name: '王总' })).toBeInViewport({ ratio: 1 });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: '王总' })).toHaveCount(0);
  }
});

test('评审表：横向滚动到最后一个检查项时编号列仍然可见，页面不横向滚动', async ({ page, request }) => {
  const productId = await createProduct(request);
  const boss = await createMember(request, '老板乙');
  await applyReviewWorkflow(request, productId, boss);
  await createRequirement(request, productId, LONG);
  await login(page, OWNER.email, OWNER.password);
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/acme/reviews');
    const last = page.getByRole('columnheader', { name: '设计签字' });
    await expect(last).toBeVisible();
    await expectNoPageOverflow(page);
    await page.getByRole('table').evaluate((table) => {
      const box = table.parentElement!;
      box.scrollLeft = box.scrollWidth;
    });
    await expect(last).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole('cell', { name: 'PAN-1', exact: true })).toBeInViewport({ ratio: 1 });
  }
});

test('发布版本：操作列固定在右侧，不用横向滚动就能点到「标记发布」', async ({ page, request }) => {
  const productId = await createProduct(request);
  const iterationId = await createIteration(request, productId, '迭代0801', '2026-08-01', '2026-08-14');
  await ok(request.post('/api/v1/orgs/acme/releases', { data: { productId, versionName: '3.2.0', iterationId, plannedDate: '2026-08-14' } }));
  await login(page, OWNER.email, OWNER.password);
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/acme/iterations/${iterationId}`);
    await page.getByRole('tab', { name: '发布版本' }).click();
    await expect(page.getByRole('button', { name: '标记发布 3.2.0' })).toBeInViewport({ ratio: 1 });
    await expectNoPageOverflow(page);
  }
});

test('工作台：800px 下四个区块单列排列、标题不被挤没；1440px 下三列', async ({ page, request }) => {
  const productId = await createProduct(request);
  const me = (await json<{ me: { memberId: string } }>(request.get('/api/v1/orgs/acme'))).me.memberId;
  const boss = await createMember(request, '老板乙');
  await applyReviewWorkflow(request, productId, boss);
  const req = (await json<{ requirement: { id: string } }>(request.post(`/api/v1/orgs/acme/products/${productId}/requirements`, { data: { title: LONG, ownerMemberId: me } })))
    .requirement;
  await ok(request.put(`/api/v1/orgs/acme/requirements/${req.id}/checks/feasibility`, { data: { state: 'passed' } }));

  await login(page, OWNER.email, OWNER.password);
  const owned = page.getByRole('region', { name: /我负责的需求/ });
  const following = page.getByRole('region', { name: /等我跟进/ });
  const tasks = page.getByRole('region', { name: /我的任务/ });
  const sign = page.getByRole('region', { name: /等我确认 检查项/ });

  await page.setViewportSize({ width: 800, height: 900 });
  await page.goto('/acme');
  await expect(sign.getByRole('link')).toHaveCount(2);
  const a = (await owned.boundingBox())!;
  const b = (await following.boundingBox())!;
  expect(b.y).toBeGreaterThanOrEqual(a.y + a.height);
  for (const title of await sign.getByText(LONG, { exact: true }).all()) expect((await title.boundingBox())!.width).toBeGreaterThanOrEqual(200);
  await expectNoPageOverflow(page);

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(async () => Math.abs((await owned.boundingBox())!.y - (await following.boundingBox())!.y)).toBeLessThan(1);
  await expect.poll(async () => Math.abs((await owned.boundingBox())!.y - (await tasks.boundingBox())!.y)).toBeLessThan(1);
  await expect.poll(async () => (await sign.boundingBox())!.y).toBeGreaterThan((await tasks.boundingBox())!.y + (await tasks.boundingBox())!.height - 1);
  await expectNoPageOverflow(page);
});
