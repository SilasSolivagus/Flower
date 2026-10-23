import { mkdirSync } from 'node:fs';
import { expect, type APIRequestContext, type Page, test } from '@playwright/test';
import { resetDatabase } from './db';
import { acceptInvite, createProduct, json, login, ok, OWNER, setupInstance } from './helpers';

const SHOTS = '/opt/cursor/artifacts/rw-p2';

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
  mkdirSync(SHOTS, { recursive: true });
});

function shanghaiToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const next = new Date(Date.UTC(y!, m! - 1, d! + days));
  return next.toISOString().slice(0, 10);
}

async function activate(request: APIRequestContext, productId: string, name: string, start: string, end: string): Promise<void> {
  const id = (
    await json<{ iteration: { id: string } }>(
      request.post('/api/v1/orgs/acme/iterations', { data: { type: 'regular', productId, name, startDate: start, endDate: end } }),
    )
  ).iteration.id;
  await ok(request.post(`/api/v1/orgs/acme/iterations/${id}/status`, { data: { to: 'active' } }));
}

/** 有此刻迭代、负责的需求和指派给自己的任务，六块里至少两块有数。 */
async function seedWorkbench(request: APIRequestContext, iterationName: string): Promise<void> {
  const today = shanghaiToday();
  const productId = await createProduct(request, '甲产品', 'AAA');
  const me = (await json<{ me: { memberId: string } }>(request.get('/api/v1/orgs/acme'))).me.memberId;
  const created = await json<{ iteration: { id: string } }>(
    request.post('/api/v1/orgs/acme/iterations', {
      data: { type: 'regular', productId, name: iterationName, startDate: addDays(today, -10), endDate: addDays(today, 10) },
    }),
  );
  const iterationId = created.iteration.id;
  await ok(request.post(`/api/v1/orgs/acme/iterations/${iterationId}/status`, { data: { to: 'active' } }));
  const req = (
    await json<{ requirement: { id: string } }>(request.post(`/api/v1/orgs/acme/products/${productId}/requirements`, { data: { title: '上传提速', ownerMemberId: me } }))
  ).requirement;
  await ok(request.put(`/api/v1/orgs/acme/requirements/${req.id}/iteration`, { data: { iterationId } }));
  await ok(request.post(`/api/v1/orgs/acme/requirements/${req.id}/blockers`, { data: { description: '等接口' } }));
  await ok(request.post('/api/v1/orgs/acme/tasks', { data: { iterationId, requirementId: req.id, title: '接口联调', assigneeMemberId: me, planStart: today, planDays: 2 } }));
}

async function assignTag(request: APIRequestContext, tagName: string): Promise<void> {
  const me = (await json<{ me: { memberId: string } }>(request.get('/api/v1/orgs/acme'))).me.memberId;
  const tags = (await json<{ tags: Array<{ id: string; name: string }> }>(request.get('/api/v1/orgs/acme/function-tags'))).tags;
  const tag = tags.find((item) => item.name === tagName);
  if (!tag) throw new Error(`缺少职能标签 ${tagName}`);
  await ok(request.put(`/api/v1/orgs/acme/members/${me}/function-tags`, { data: { tagIds: [tag.id] } }));
}

function personaRoot(page: Page) {
  return page.locator('[data-persona]');
}

function switcher(page: Page) {
  return page.getByLabel('以视角查看');
}

const SIX = ['我负责的需求', '等我跟进', '我的任务', '等我确认 检查项', '等我确认 简报', '未读评论'] as const;

test('无标签无偏好时是中性布局，此刻迭代仍在六块之上', async ({ page, request }) => {
  await seedWorkbench(request, '甲此刻');
  await login(page, OWNER.email, OWNER.password);
  await page.waitForURL('**/acme');
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(switcher(page)).toBeEnabled();
  await expect(switcher(page)).toHaveValue('neutral');
  await expect(personaRoot(page)).toHaveAttribute('data-persona', 'neutral');
  await expect(personaRoot(page)).toHaveAttribute('data-persona-source', 'neutral');
  await expect(page.locator('[data-section-order]')).toHaveAttribute('data-section-order', 'owned following tasks signatures confirmations unread');
  await expect(page.locator('[data-emphasis="primary"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '显示次要' })).toHaveCount(0);
  await expect(page.locator('[data-slot="external-pending"]')).toHaveCount(0);
  const now = page.getByRole('region', { name: '此刻迭代' });
  await expect(now.getByRole('link', { name: /接口联调/ })).toBeVisible();
  await expect(now.getByText('活跃阻塞 1')).toBeVisible();
  for (const name of SIX) await expect(page.getByRole('region', { name: new RegExp(name) })).toBeVisible();
  const grid = page.locator('[class*="xl:grid-cols-2"]');
  expect((await now.boundingBox())!.y).toBeLessThan((await grid.boundingBox())!.y);
  const following = page.getByRole('region', { name: /等我跟进/ });
  await expect(following).toContainText('没有等你跟进的条目');
  expect((await following.boundingBox())!.height).toBeLessThan(120);
  await page.screenshot({ path: `${SHOTS}/workbench-persona-neutral-1280.png` });
  await page.setViewportSize({ width: 1920, height: 900 });
  await expect.poll(async () => (await grid.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').filter(Boolean).length))).toBe(3);
  expect((await now.boundingBox())!.y).toBeLessThan((await grid.boundingBox())!.y);
  await page.screenshot({ path: `${SHOTS}/workbench-persona-neutral-1920.png` });
});

test('产品标签的布局与中性可区分，六块仍在，外接槽不造假数据', async ({ page, request }) => {
  await seedWorkbench(request, '甲此刻');
  await assignTag(request, '产品经理');
  await login(page, OWNER.email, OWNER.password);
  await page.waitForURL('**/acme');
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(personaRoot(page)).toHaveAttribute('data-persona', 'pm');
  await expect(personaRoot(page)).toHaveAttribute('data-persona-source', 'tag');
  await expect(page.locator('[data-section-order]')).toHaveAttribute('data-section-order', 'confirmations following owned signatures unread tasks');
  await expect(page.locator('[data-section="tasks"]')).toHaveAttribute('data-collapsed', 'true');
  await expect(page.locator('[data-section="tasks"]').getByRole('link', { name: /接口联调/ })).toHaveCount(0);
  await expect(page.locator('[data-section="confirmations"]')).toHaveAttribute('data-emphasis', 'primary');
  const now = page.getByRole('region', { name: '此刻迭代' });
  await expect(now.getByRole('heading', { name: '此刻迭代' })).toBeVisible();
  await expect(now.getByRole('link', { name: /接口联调/ })).toHaveCount(0);
  await expect(now.getByText('活跃阻塞 1')).toBeVisible();
  await expect(now.locator('[data-slot="external-pending"]')).toHaveCount(0);
  for (const name of SIX) await expect(page.getByRole('region', { name: new RegExp(name) })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/workbench-persona-pm-1280.png` });
  await now.getByRole('button', { name: '显示次要' }).click();
  await expect(now.getByRole('link', { name: /接口联调/ })).toBeVisible();
  await page.locator('[data-section="tasks"]').getByRole('button', { name: '展开此块' }).click();
  await expect(page.locator('[data-section="tasks"]').getByRole('link', { name: /接口联调/ })).toBeVisible();
});

test('视角切换改变布局，标题稳定，偏好在刷新后还在', async ({ page, request }) => {
  await seedWorkbench(request, '甲此刻');
  await login(page, OWNER.email, OWNER.password);
  await page.waitForURL('**/acme');
  await page.setViewportSize({ width: 1280, height: 900 });
  const sw = switcher(page);
  await expect(sw).toHaveValue('neutral');
  await sw.selectOption('dev');
  await expect(personaRoot(page)).toHaveAttribute('data-persona', 'dev');
  await expect(personaRoot(page)).toHaveAttribute('data-persona-source', 'preference');
  await expect(page.locator('[data-section-order]')).toHaveAttribute('data-section-order', 'tasks following owned unread signatures confirmations');
  await expect(page.getByRole('region', { name: '此刻迭代' })).toBeVisible();
  await expect(page.locator('[data-slot="external-pending"]')).toHaveText('仓库状态即将接入');
  await expect(page.locator('[data-slot="external-pending"] a')).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/workbench-persona-dev-1280.png` });
  await page.screenshot({ path: `${SHOTS}/workbench-persona-switch-1280.png` });
  await sw.selectOption('design');
  await expect(personaRoot(page)).toHaveAttribute('data-persona', 'design');
  await expect(page.locator('[data-slot="external-pending"]')).toHaveText('设计稿状态即将接入');
  const saved = page.waitForResponse((res) => res.url().includes('/api/v1/me') && res.request().method() === 'PATCH' && res.ok());
  await sw.selectOption('qa');
  await saved;
  await expect(personaRoot(page)).toHaveAttribute('data-persona', 'qa');
  await expect(page.locator('[data-slot="external-pending"]')).toHaveText('测试流水线即将接入');
  await expect(page.locator('[data-section="tasks"]')).toHaveAttribute('data-collapsed', 'true');
  await page.reload();
  await expect(switcher(page)).toHaveValue('qa');
  await expect(personaRoot(page)).toHaveAttribute('data-persona', 'qa');
  await expect(personaRoot(page)).toHaveAttribute('data-persona-source', 'preference');
  await sw.selectOption('neutral');
  await expect(personaRoot(page)).toHaveAttribute('data-persona', 'neutral');
  await expect(page.getByRole('region', { name: '此刻迭代' })).toBeVisible();
  await expect(page.locator('[data-slot="external-pending"]')).toHaveCount(0);
});

test('?persona= 只预览，不改偏好，关掉后回到解析链', async ({ page, request }) => {
  await seedWorkbench(request, '甲此刻');
  await assignTag(request, '产品经理');
  await login(page, OWNER.email, OWNER.password);
  await page.waitForURL('**/acme');
  await expect(personaRoot(page)).toHaveAttribute('data-persona', 'pm');
  const before = (await json<{ account: { preferences: { workbenchPersona?: string | null } } }>(request.get('/api/v1/me'))).account.preferences.workbenchPersona ?? null;
  await page.goto('/acme?persona=boss');
  await expect(personaRoot(page)).toHaveAttribute('data-persona', 'boss');
  await expect(personaRoot(page)).toHaveAttribute('data-persona-source', 'url');
  await expect(page.getByText('预览', { exact: true })).toBeVisible();
  await expect(switcher(page)).toHaveValue('boss');
  const during = (await json<{ account: { preferences: { workbenchPersona?: string | null } } }>(request.get('/api/v1/me'))).account.preferences.workbenchPersona ?? null;
  expect(during).toBe(before);
  const workbench = await json<{ workbench: Record<string, unknown> }>(request.get('/api/v1/me/workbench?org=acme'));
  expect(workbench.workbench).not.toHaveProperty('resolvedPersona');
  await page.goto('/acme');
  await expect(personaRoot(page)).toHaveAttribute('data-persona', 'pm');
  await expect(personaRoot(page)).toHaveAttribute('data-persona-source', 'tag');
  await expect(page.getByText('预览', { exact: true })).toHaveCount(0);
});

test('访客用管理者视角仍看不到不可见产品，切换也不提权', async ({ page, request }) => {
  const today = shanghaiToday();
  const start = addDays(today, -5);
  const end = addDays(today, 5);
  const visible = await createProduct(request, '甲产品', 'AAA');
  const hidden = await createProduct(request, '隐产品', 'HID');
  await activate(request, visible, '甲此刻', start, end);
  await activate(request, hidden, '机密迭代', start, end);
  const guestId = await acceptInvite(page, request, { email: 'guest-persona@example.com', orgRole: 'guest', name: '访客视角' });
  await ok(request.put(`/api/v1/orgs/acme/products/${visible}/roles/${guestId}`, { data: { role: 'viewer' } }));
  await page.goto('/acme?persona=boss');
  await expect(page.getByRole('region', { name: '此刻迭代' }).getByRole('link', { name: '甲此刻' })).toBeVisible();
  await expect(page.getByText('机密迭代')).toHaveCount(0);
  await expect(page.getByText('加载工作台失败')).toHaveCount(0);
  await expect(page.getByText('访客无权查看此内容')).toHaveCount(0);
  await expect(personaRoot(page)).toHaveAttribute('data-persona', 'boss');
  await expect(switcher(page)).toBeEnabled();
  await switcher(page).selectOption('qa');
  await expect(personaRoot(page)).toHaveAttribute('data-persona', 'qa');
  await expect(page.getByText('机密迭代')).toHaveCount(0);
  await expect(page.getByText('加载工作台失败')).toHaveCount(0);
});
