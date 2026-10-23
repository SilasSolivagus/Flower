import { expect, type Page, test } from '@playwright/test';
import { resetDatabase } from './db';
import { createIteration, createProduct, expectNoPageOverflow, json, login, ok, OWNER, preferAllRequirements, setupInstance } from './helpers';

const SHOTS = '/opt/cursor/artifacts/screenshots';
const HIDDEN_COLUMNS = ['平台', '业务域', '提出人', '更新'] as const;
const TITLE = '分享链接支持设置密码并统计访问来源';

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

function columnHeader(page: Page, name: string) {
  return page.locator('thead th').filter({ hasText: new RegExp(`^${name}$`) });
}

test('DUX-005：1280 默隐次要列且主列可读；760 标题仍优先', async ({ page, request }) => {
  const productId = await createProduct(request);
  const fields = (await (await ok(request.get('/api/v1/orgs/acme/fields'))).json()).fields as Array<{
    key: string;
    options: Array<{ key: string; id: string }>;
  }>;
  const p0 = fields.find((f) => f.key === 'priority')!.options.find((o) => o.key === 'p0')!.id;
  const me = (await json<{ me: { memberId: string } }>(request.get('/api/v1/orgs/acme'))).me.memberId;
  const req = (
    await json<{ requirement: { id: string; displayKey: string } }>(
      request.post(`/api/v1/orgs/acme/products/${productId}/requirements`, {
        data: { title: TITLE, ownerMemberId: me, fields: { priority: [p0] } },
      }),
    )
  ).requirement;
  const iterationId = await createIteration(request, productId, '10月迭代', '2026-10-01', '2026-10-14');
  await ok(request.put(`/api/v1/orgs/acme/requirements/${req.id}/iteration`, { data: { iterationId } }));

  await preferAllRequirements(page);
  await login(page, OWNER.email, OWNER.password);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/acme/requirements');

  await expect(page.getByRole('heading', { name: '需求' })).toBeVisible();
  for (const name of ['编号', '标题', '状态', '优先级', '负责人', '迭代']) {
    await expect(columnHeader(page, name)).toBeVisible();
  }
  for (const name of HIDDEN_COLUMNS) {
    await expect(columnHeader(page, name)).toHaveCount(0);
  }

  const row = page.getByRole('row').filter({ hasText: TITLE });
  await expect(row.getByRole('link', { name: TITLE })).toBeVisible();
  await expect(row).toContainText('P0');
  await expect(row).toContainText('林澄');
  await expect(row).toContainText('10月迭代');
  await expect(row).toContainText(req.displayKey);
  await expect(row).toContainText('待处理');

  const table = page.locator('table');
  const main = page.locator('main');
  const tableBox = (await table.boundingBox())!;
  const mainBox = (await main.boundingBox())!;
  expect(tableBox.width).toBeGreaterThan(mainBox.width - 80);
  const titleCell = page.getByRole('cell', { name: TITLE });
  const titleWidth = (await titleCell.boundingBox())!.width;
  expect(titleWidth).toBeGreaterThan(280);
  const visibleHeaderWidths = await page.locator('thead th').evaluateAll((els) =>
    els
      .filter((el) => getComputedStyle(el).display !== 'none')
      .map((el) => ({ text: el.textContent?.trim() ?? '', width: el.getBoundingClientRect().width })),
  );
  const titleHeader = visibleHeaderWidths.find((c) => c.text === '标题')!;
  const widestOther = Math.max(...visibleHeaderWidths.filter((c) => c.text !== '标题').map((c) => c.width));
  expect(titleHeader.width).toBeGreaterThan(widestOther);

  const headRow = page.locator('thead tr');
  const headHeight = (await headRow.boundingBox())!.height;
  expect(headHeight).toBeGreaterThanOrEqual(40);
  expect(headHeight).toBeLessThanOrEqual(44);
  await expect(page.getByLabel('搜索需求')).toBeVisible();
  await expect(page.getByRole('combobox', { name: '迭代' })).toBeVisible();
  await expectNoPageOverflow(page);
  await page.screenshot({ path: `${SHOTS}/dux-005-list-1280.png` });

  await page.setViewportSize({ width: 1600, height: 900 });
  for (const name of HIDDEN_COLUMNS) {
    await expect(columnHeader(page, name)).toHaveCount(0);
  }
  await expect(columnHeader(page, '迭代')).toBeVisible();

  await page.setViewportSize({ width: 760, height: 900 });
  for (const name of ['编号', '标题', '状态']) {
    await expect(columnHeader(page, name)).toBeVisible();
  }
  for (const name of ['优先级', '负责人', '迭代']) {
    await expect(columnHeader(page, name)).toHaveCount(1);
    await expect(columnHeader(page, name)).toBeHidden();
  }
  for (const name of HIDDEN_COLUMNS) {
    await expect(columnHeader(page, name)).toHaveCount(0);
  }
  const narrowTitle = page.getByRole('cell', { name: TITLE });
  await expect(narrowTitle).toBeVisible();
  expect((await narrowTitle.boundingBox())!.width).toBeGreaterThan(160);
  await expectNoPageOverflow(page);
  await page.screenshot({ path: `${SHOTS}/dux-005-list-760.png` });
});
