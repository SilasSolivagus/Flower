import { mkdirSync } from 'node:fs';
import { expect, type Locator, test } from '@playwright/test';
import { resetDatabase } from './db';
import { acceptInvite, createMember, createProduct, createRequirement, expectNoPageOverflow, json, login, ok, OWNER, setupInstance } from './helpers';

const SHOTS = '/opt/cursor/artifacts/screenshots';
const NO_PERMISSION = '无权访问，请联系组织管理员';
const REQUIREMENT_NOTE = '工作项不关联需求；请从需求详情看关联';

test.beforeAll(() => {
  mkdirSync(SHOTS, { recursive: true });
});

test.beforeEach(async () => {
  await resetDatabase();
});

async function fullyInView(locator: Locator): Promise<void> {
  await expect(locator).toBeInViewport({ ratio: 1 });
  const box = (await locator.boundingBox())!;
  const viewport = locator.page().viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
}

test('E1：760 跟进阶段完整可见，写进展不用横滑；1280 写进展仍在首屏', async ({ page, request }) => {
  await setupInstance(request);
  const productId = await createProduct(request);
  const doing = await createRequirement(request, productId, '开发中的需求');
  await ok(request.post(`/api/v1/orgs/acme/requirements/${doing.id}/transitions`, { data: { to: 'doing' } }));
  await login(page, OWNER.email, OWNER.password);

  await page.setViewportSize({ width: 760, height: 900 });
  await page.goto('/acme/tracking');
  const row = page.getByRole('list', { name: '全部在手' }).getByRole('listitem').filter({ hasText: '开发中的需求' });
  const stage = row.getByText('进行中', { exact: true });
  const write = row.getByRole('button', { name: `写进展：${doing.displayKey}` });
  await fullyInView(stage);
  await fullyInView(write);
  await expectNoPageOverflow(page);
  await write.click();
  await expect(page.getByRole('dialog', { name: '写进展' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '写进展' })).toBeHidden();
  await page.screenshot({ path: `${SHOTS}/tracking-760.png` });

  await page.setViewportSize({ width: 1280, height: 900 });
  const tableRow = page.getByRole('table', { name: '全部在手' }).getByRole('row', { name: /开发中的需求/ });
  await fullyInView(tableRow.getByText('进行中', { exact: true }));
  await fullyInView(tableRow.getByRole('button', { name: `写进展：${doing.displayKey}` }));
  await expectNoPageOverflow(page);
  await page.screenshot({ path: `${SHOTS}/tracking-1280.png` });
});

test('E2：工作项详情只显示不关联需求的说明，没有关联控件', async ({ page, request }) => {
  await setupInstance(request);
  await createProduct(request);
  const created = await json<{ workItem: { displayKey: string } }>(request.post('/api/v1/orgs/acme/work-items', { data: { title: '协助客服排查' } }));
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/work-items/${created.workItem.displayKey}`);
  const info = page.getByRole('region', { name: '基本信息' });
  await expect(info.getByText(REQUIREMENT_NOTE)).toBeVisible();
  await expect(page.getByRole('combobox', { name: '关联需求' })).toHaveCount(0);
  await expect(page.getByLabel('关联需求')).toHaveCount(0);
  await expect(info.getByLabel('关联产品')).toBeVisible();
});

test('F1：无权限看不到设置入口；直链和子页都是同一句中文，不是英文 404', async ({ browser, request }) => {
  await setupInstance(request);
  const productId = await createProduct(request);
  const ctx = await browser.newContext();
  const member = await ctx.newPage();
  await acceptInvite(member, request, { email: 'member@example.com', orgRole: 'member', name: '成员甲' });
  await expect(member.getByText('组织设置')).toHaveCount(0);
  await expect(member.locator('nav[aria-label="主导航"] a[href="/acme/settings/members"]')).toHaveCount(0);

  for (const path of ['/acme/settings', '/acme/settings/members', '/acme/settings/general', '/acme/settings/does-not-exist', `/acme/settings/products/${productId}`]) {
    await member.goto(path);
    await expect(member.getByRole('heading', { name: '无权访问' })).toBeVisible();
    await expect(member.getByText(NO_PERMISSION)).toBeVisible();
    await expect(member.getByText('This page could not be found')).toHaveCount(0);
    await expect(member.getByRole('heading', { name: '404' })).toHaveCount(0);
    await expect(member.locator('body')).not.toContainText('404');
  }
  await ctx.close();
});

test('F2：760 用顶栏切换设置子页，说明横排可读，成员表可看；侧栏设置可收起', async ({ page, request }) => {
  await setupInstance(request);
  await createMember(request, '王总');
  await login(page, OWNER.email, OWNER.password);

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/acme/settings/members');
  await expect(page.getByRole('navigation', { name: '组织设置' })).toBeHidden();
  await expect(page.locator('nav[aria-label="主导航"] a[href="/acme/settings/members"]')).toBeVisible();
  await expect(page.getByRole('row', { name: /王总/ })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/settings-members-1280.png` });

  await page.setViewportSize({ width: 760, height: 900 });
  const subnav = page.getByRole('navigation', { name: '组织设置' });
  await expect(subnav.getByRole('link', { name: '成员' })).toHaveAttribute('aria-current', 'page');
  const name = page.getByRole('row', { name: /王总/ }).getByText('王总', { exact: true });
  await fullyInView(name);
  await fullyInView(page.getByRole('row', { name: /王总/ }).getByText('在职'));
  await fullyInView(page.getByRole('row', { name: /王总/ }).getByRole('button', { name: '查看王总' }));
  await page.screenshot({ path: `${SHOTS}/settings-members-760.png` });
  const intro = page.getByText('无账号成员也可以被指派为提出人或负责人');
  expect((await intro.boundingBox())!.width).toBeGreaterThan(180);
  await expectNoPageOverflow(page);

  await expect(page.getByRole('navigation', { name: '主导航' })).toBeHidden();
  await page.getByRole('button', { name: '打开导航' }).click();
  const toggle = page.locator('nav[aria-label="主导航"]').getByRole('button', { name: '组织设置' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '产品' })).toBeVisible();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('button', { name: '收起导航' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeHidden();

  await subnav.getByRole('link', { name: '产品' }).click();
  await expect(page).toHaveURL(/\/acme\/settings\/products$/);
  await expect(page.getByRole('heading', { name: '产品', level: 1 })).toBeVisible();
  await subnav.getByRole('link', { name: '跟进' }).click();
  await expect(page).toHaveURL(/\/acme\/settings\/tracking$/);
  const trackingIntro = page.getByText('跟进页「任务老化」的阈值');
  await expect(trackingIntro).toBeVisible();
  expect((await trackingIntro.boundingBox())!.width).toBeGreaterThan(180);
  await expectNoPageOverflow(page);
  await page.screenshot({ path: `${SHOTS}/settings-760.png` });
});

test('F3：成员改为已离开时取消确认，状态不变', async ({ page, request }) => {
  await setupInstance(request);
  const memberId = await createMember(request, '王总');
  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme/settings/members');
  await page.getByRole('button', { name: '查看王总' }).click();
  const drawer = page.getByRole('dialog', { name: '王总' });
  await drawer.getByLabel('状态').click();
  await page.getByRole('option', { name: '已离开' }).click();
  await drawer.getByRole('button', { name: '保存' }).click();
  const confirm = page.getByRole('dialog', { name: '设为已离开' });
  await expect(confirm).toBeVisible();
  await expect(confirm.getByRole('button', { name: '取消' })).toBeFocused();
  await confirm.getByRole('button', { name: '取消' }).click();
  await expect(confirm).toHaveCount(0);
  await expect(drawer.getByLabel('状态')).toHaveText('在职');
  await drawer.getByRole('button', { name: '取消' }).click();
  await expect(drawer).toHaveCount(0);
  await expect(page.getByRole('row', { name: /王总/ })).toContainText('在职');
  const members = await json<{ members: Array<{ id: string; status: string }> }>(request.get('/api/v1/orgs/acme/members'));
  expect(members.members.find((m) => m.id === memberId)?.status).toBe('active');
});

test('F4：产品归档点取消后仍是启用', async ({ page, request }) => {
  await setupInstance(request);
  const productId = await createProduct(request);
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/settings/products/${productId}`);
  await page.getByRole('button', { name: '归档产品' }).click();
  const confirm = page.getByRole('dialog', { name: '归档产品' });
  await expect(confirm).toContainText('确认后才会归档');
  await expect(confirm.getByRole('button', { name: '取消' })).toBeFocused();
  await confirm.getByRole('button', { name: '取消' }).click();
  await expect(confirm).toHaveCount(0);
  await expect(page.getByRole('button', { name: '归档产品' })).toBeVisible();
  await expect(page.getByText('已归档')).toHaveCount(0);
  const product = await json<{ product: { status: string } }>(request.get(`/api/v1/orgs/acme/products/${productId}`));
  expect(product.product.status).toBe('active');
});
