import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { applyPrdWorkflow, applyReviewWorkflow, createDocument, createMember, createProduct, createRequirement, expectNoPageOverflow, FAIL_500, login, ok, OWNER, setupInstance } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

test('评审表：按检查项生成列，统计与「等我签字」筛选，展开后本人签字与代签', async ({ page, request }) => {
  const productId = await createProduct(request);
  const boss = await createMember(request, '老板乙');
  await applyReviewWorkflow(request, productId, boss);
  await createRequirement(request, productId, '未开始的需求');
  const started = await createRequirement(request, productId, '评审中的需求');
  await ok(request.put(`/api/v1/orgs/acme/requirements/${started.id}/checks/feasibility`, { data: { state: 'passed' } }));

  await login(page, OWNER.email, OWNER.password);
  await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '评审' }).click();
  await expect(page).toHaveURL(/\/acme\/reviews$/);
  await expect(page.getByRole('columnheader', { name: '设计签字' })).toBeVisible();
  const stats = page.getByRole('group', { name: '评审统计' });
  await expect(stats.getByRole('button', { name: /未开始/ })).toContainText('1');
  await expect(stats.getByRole('button', { name: /评审中/ })).toContainText('1');

  await page.getByRole('checkbox', { name: '等我签字' }).click();
  const row = page.getByRole('row').filter({ hasText: '评审中的需求' });
  await expect(row).toContainText('待我签');
  await expect(page.getByRole('row').filter({ hasText: '未开始的需求' })).toHaveCount(0);

  await page.getByRole('button', { name: '展开 PAN-2' }).click();
  const design = page.getByRole('listitem', { name: '设计签字' });
  await design.getByRole('button', { name: '通过' }).click();
  await expect(page.getByText('已签字')).toBeVisible();
  await expect(row.first()).toContainText('进行中 1/2');
  await expect(row.first()).toContainText('可代签');

  await design.getByRole('button', { name: '代签' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '确认代签' }).click();
  await expect(stats.getByRole('button', { name: /已通过/ })).toContainText('1');
  await expect(page.getByText('没有符合条件的需求')).toBeVisible();
});

test('评审表：流程没有检查项时给出提示', async ({ page, request }) => {
  await createProduct(request);
  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme/reviews');
  await expect(page.getByText('这个产品的流程没有配置检查项')).toBeVisible();
});

test('PRD 评审表：1440 与 760 宽度下不横向滚动，关键内容在视口内；加载失败显示重试', async ({ page, request }) => {
  const productId = await createProduct(request);
  await applyPrdWorkflow(request, productId);
  const doc = await createDocument(request, productId, { title: '分片上传', externalUrl: 'https://doc.weixin.qq.com/doc/w3_SP' });
  await ok(request.post(`/api/v1/orgs/acme/documents/${doc.id}/transitions`, { data: { to: 'review' } }));
  await login(page, OWNER.email, OWNER.password);

  for (const width of [1440, 760]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/acme/reviews');
    const section = page.getByRole('region', { name: 'PRD 评审' });
    await expect(section.getByRole('row', { name: new RegExp(doc.displayKey) })).toBeInViewport({ ratio: 1 });
    await expectNoPageOverflow(page);
  }

  const queueUrl = `**/api/v1/orgs/acme/products/${productId}/document-reviews`;
  await page.route(queueUrl, (route) => route.fulfill(FAIL_500));
  await page.goto('/acme/reviews');
  await expect(page.getByText('加载 PRD 评审失败，请重试。')).toBeVisible({ timeout: 15_000 });
  await page.unroute(queueUrl);
  await page.getByRole('button', { name: '重试' }).click();
  await expect(page.getByRole('region', { name: 'PRD 评审' }).getByRole('row', { name: new RegExp(doc.displayKey) })).toBeVisible();
});
