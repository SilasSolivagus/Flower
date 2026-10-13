import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { adminSql, resetDatabase } from './db';
import { acceptInvite, createIteration, createProduct, createRequirement, expectNoPageOverflow, json, login, ok, OWNER, setupInstance } from './helpers';

test.beforeEach(async () => {
  await resetDatabase();
});

const STATES = [
  { key: 'backlog', label: '待处理', color: '#94a3b8', order: 1, group: '', category: 'backlog' },
  { key: 'todo', label: '待开始', color: '#60a5fa', order: 2, group: '', category: 'unstarted' },
  { key: 'doing', label: '进行中', color: '#f59e0b', order: 3, group: '', category: 'started' },
  { key: 'done', label: '已完成', color: '#10b981', order: 4, group: '', category: 'completed' },
  { key: 'canceled', label: '已取消', color: '#9ca3af', order: 5, group: '', category: 'canceled' },
];

/** 组织时区（默认 Asia/Shanghai）下今天加 offset 天的日期。 */
async function day(offset: number): Promise<string> {
  const [row] = await adminSql<{ d: string }>(`select to_char((now() at time zone 'Asia/Shanghai')::date + $1::int, 'YYYY-MM-DD') as d`, [offset]);
  return row!.d;
}

/** 改写需求的流转历史：createdAgo 天前创建于「待处理」，steps 为依次进入的状态与「几天前」。 */
async function history(id: string, createdAgo: number, steps: Array<[string, number]>): Promise<void> {
  const rows: Array<[string | null, string, number]> = [[null, 'backlog', createdAgo]];
  let prev = 'backlog';
  for (const [to, ago] of steps) {
    rows.push([prev, to, ago]);
    prev = to;
  }
  await adminSql('delete from state_transitions where requirement_id = $1', [id]);
  for (const [from, to, ago] of rows) {
    await adminSql(
      `insert into state_transitions (id, org_id, requirement_id, from_state, to_state, at)
       select gen_random_uuid(), org_id, id, $2::text, $3::text, now() - make_interval(days => $4::int) from requirements where id = $1`,
      [id, from, to, ago],
    );
  }
  await adminSql(
    `update requirements set state_key = $2, created_at = now() - make_interval(days => $3::int), state_changed_at = now() - make_interval(days => $4::int) where id = $1`,
    [id, prev, createdAgo, rows.at(-1)![2]],
  );
}

/**
 * 网盘产品：五条需求（两条已完成、两条进行中、一条已取消）；Sprint 0（无承诺范围）与 Sprint 1（承诺范围含需求二）；
 * 版本 v1.0（按期）与 v1.1（无基线日期，按 Sprint 1 结束日计，逾期 1 天）；专项甲（需求一、三）；需求一先驳回后通过、需求二通过。
 */
async function seed(request: APIRequestContext): Promise<void> {
  await setupInstance(request);
  const pan = await createProduct(request);
  const wf = await json<{ version: { id: string } }>(
    request.post('/api/v1/orgs/acme/workflows', {
      data: {
        name: '看板流程',
        body: {
          states: STATES,
          initial: 'backlog',
          transitions: STATES.map((s) => ({ from: '*', to: s.key, conditions: [] })),
          checkItems: [{ key: 'feasibility', label: '可行性', scope: 'requirement', type: 'single' }],
        },
      },
    }),
  );
  await ok(request.put(`/api/v1/orgs/acme/products/${pan}/workflow`, { data: { versionId: wf.version.id } }));
  const r1 = await createRequirement(request, pan, '已完成的需求一');
  const r2 = await createRequirement(request, pan, '已完成的需求二');
  const r3 = await createRequirement(request, pan, '卡住的需求');
  const r4 = await createRequirement(request, pan, '刚开始的需求');
  const r5 = await createRequirement(request, pan, '取消的需求');
  const sprint0 = await createIteration(request, pan, 'Sprint 0', await day(-60), await day(-31));
  const sprint1 = await createIteration(request, pan, 'Sprint 1', await day(-30), await day(-1));
  await ok(request.put(`/api/v1/orgs/acme/requirements/${r2.id}/iteration`, { data: { iterationId: sprint1 } }));
  for (const it of [sprint0, sprint1]) {
    for (const to of ['active', 'done']) await ok(request.post(`/api/v1/orgs/acme/iterations/${it}/status`, { data: { to } }));
  }
  const special = (
    await json<{ iteration: { id: string } }>(
      request.post('/api/v1/orgs/acme/iterations', { data: { type: 'special', name: '专项甲', startDate: await day(-30), endDate: await day(30) } }),
    )
  ).iteration.id;
  for (const r of [r1, r3]) await ok(request.put(`/api/v1/orgs/acme/requirements/${r.id}/iteration`, { data: { iterationId: special } }));
  await history(r1.id, 40, [['doing', 30], ['done', 20]]);
  await history(r2.id, 25, [['doing', 15], ['done', 5]]);
  await history(r3.id, 50, [['doing', 45]]);
  await history(r4.id, 3, [['doing', 2]]);
  await history(r5.id, 10, [['canceled', 8]]);
  const release = async (data: Record<string, unknown>) => (await json<{ release: { id: string } }>(request.post('/api/v1/orgs/acme/releases', { data }))).release.id;
  const v10 = await release({ productId: pan, versionName: 'v1.0', plannedDate: await day(30) });
  const v11 = await release({ productId: pan, versionName: 'v1.1', iterationId: sprint1, plannedDate: await day(30) });
  await adminSql('update releases set baseline_date = null where id = $1', [v11]);
  for (const id of [v10, v11]) await ok(request.post(`/api/v1/orgs/acme/releases/${id}/released`));
  await ok(request.put(`/api/v1/orgs/acme/requirements/${r1.id}/checks/feasibility`, { data: { state: 'rejected' } }));
  await ok(request.put(`/api/v1/orgs/acme/requirements/${r1.id}/checks/feasibility`, { data: { state: 'passed' } }));
  await ok(request.put(`/api/v1/orgs/acme/requirements/${r2.id}/checks/feasibility`, { data: { state: 'passed' } }));
}

const card = (page: Page, name: string) => page.getByRole('region', { name, exact: true });
/** 关键数字卡片的数值本身（不含口径按钮与对比说明）。 */
const cardValue = (page: Page, name: string) => card(page, name).locator('div.font-mono');

test('产品看板：关键数字与口径、趋势、卡在哪儿、迭代与版本、专项、评审；切换时间段、按迭代与自定义；1440 与 760 不横向滚动', async ({ page, request }) => {
  await seed(request);
  await login(page, OWNER.email, OWNER.password);
  await page.locator('nav[aria-label="主导航"] a[href="/acme/dashboard"]').click();
  await expect(page.getByRole('heading', { name: '看板', level: 1 })).toBeVisible();

  // 关键数字：近 90 天完成 2 条（2 × 7 ÷ 90 ≈ 0.2 条/周）；前置时间都是 20 天、流动时间都是 10 天；进行中 2 条；
  // 版本 1 按期 1 逾期；可行性 2 个有结论、1 个驳回过。上期早于数据起点，显示「上期暂无数据」
  await expect(card(page, '吞吐量（周均）')).toContainText('0.2 条/周');
  await expect(card(page, '吞吐量（周均）')).toContainText('上期暂无数据');
  await expect(card(page, '前置时间中位数')).toContainText('20.0 天');
  await expect(card(page, '流动时间中位数')).toContainText('10.0 天');
  await expect(cardValue(page, '当前在制品')).toHaveText('2');
  await expect(card(page, '版本按期达成率')).toContainText('50%');
  await expect(card(page, '驳回率')).toContainText('50%');
  await page.getByRole('button', { name: '前置时间中位数的口径' }).hover();
  await expect(page.getByRole('tooltip')).toContainText('需求创建到最后一次进入');

  await expect(page.getByRole('table', { name: '每周吞吐量' })).toBeAttached();
  await expect(page.getByRole('table', { name: '在制品周趋势' })).toBeAttached();
  await expect(page.getByRole('table', { name: '各状态停留' }).getByRole('row', { name: /进行中/ })).toContainText('23.5 天');
  const oldest = page.getByRole('table', { name: '停留最久的需求' });
  await expect(oldest.getByRole('row').nth(1)).toContainText('PAN-3');
  await expect(oldest.getByRole('row').nth(1)).toContainText('45.0 天');

  const iterations = page.getByRole('table', { name: '迭代承诺' });
  await expect(iterations.getByRole('row', { name: /Sprint 1/ })).toContainText('100%');
  await expect(iterations.getByRole('row', { name: /Sprint 0/ })).toContainText('暂无数据');
  const releases = page.getByRole('table', { name: '版本', exact: true });
  await expect(releases.getByRole('row', { name: /v1\.1/ })).toContainText('按迭代结束日计');
  await expect(releases.getByRole('row', { name: /v1\.1/ })).toContainText('逾期 1 天');
  await expect(releases.getByRole('row', { name: /v1\.0/ })).toContainText('按期');
  await expect(page.getByRole('progressbar', { name: '专项甲' })).toHaveAttribute('aria-valuenow', '50');
  await expect(page.getByRole('table', { name: '各检查项评审' }).getByRole('row', { name: /可行性/ })).toContainText('50%');
  await expectNoPageOverflow(page);

  // 从停留最久的需求进入详情
  await oldest.getByRole('link', { name: 'PAN-3' }).click();
  await page.waitForURL('**/acme/requirements/PAN-3');
  await page.goBack();
  await expect(card(page, '吞吐量（周均）')).toContainText('0.2 条/周');

  // 近 30 天：同样 2 条完成，2 × 7 ÷ 30 ≈ 0.5 条/周
  await page.getByRole('combobox', { name: '时间段' }).click();
  await page.getByRole('option', { name: '近 30 天' }).click();
  await expect(page).toHaveURL(/range=30/);
  await expect(card(page, '吞吐量（周均）')).toContainText('0.5 条/周');

  // 按迭代：默认选最近开始的 Sprint 1
  await page.getByRole('button', { name: '按迭代' }).click();
  await expect(page).toHaveURL(/iteration=/);
  await expect(page.getByLabel('统计时间段')).toContainText('迭代「Sprint 1」');
  await page.getByRole('button', { name: '按迭代' }).click();
  await expect(page).not.toHaveURL(/iteration=/);

  // 自定义：近 11 天只完成需求二，1 × 7 ÷ 11 ≈ 0.6 条/周
  await page.getByRole('combobox', { name: '时间段' }).click();
  await page.getByRole('option', { name: '自定义' }).click();
  await page.getByLabel('开始日期').fill(await day(-10));
  await page.getByLabel('结束日期').fill(await day(0));
  await page.getByRole('button', { name: '应用' }).click();
  await expect(page).toHaveURL(/from=.*&to=/);
  await expect(card(page, '吞吐量（周均）')).toContainText('0.6 条/周');
  await expect(page.getByLabel('开始日期')).toHaveValue(await day(-10));
  await expect(page.getByLabel('结束日期')).toHaveValue(await day(0));

  await page.setViewportSize({ width: 760, height: 900 });
  await expect(card(page, '吞吐量（周均）')).toBeVisible();
  await expectNoPageOverflow(page);
});

test('组织汇总：组织管理员按产品对比并进入产品看板；空产品显示暂无数据与原因；普通成员无权访问汇总；1440 与 760 不横向滚动', async ({ page, request, browser }) => {
  await setupInstance(request);
  await createProduct(request, '网盘', 'PAN');
  await createProduct(request, '文档', 'DOC');
  await login(page, OWNER.email, OWNER.password);
  await page.locator('nav[aria-label="主导航"] a[href="/acme/settings/dashboard"]').click();
  await expect(page.getByRole('heading', { name: '看板', level: 1 })).toBeVisible();
  const table = page.getByRole('table', { name: '各产品关键数字' });
  await expect(table.getByRole('row')).toHaveCount(3);
  await expect(table.getByRole('row', { name: /网盘/ })).toContainText('暂无数据');
  await expectNoPageOverflow(page);
  await page.setViewportSize({ width: 760, height: 900 });
  await expectNoPageOverflow(page);

  await table.getByRole('link', { name: '网盘' }).click();
  await expect(page).toHaveURL(/\/acme\/dashboard\?product=/);
  await expect(card(page, '吞吐量（周均）')).toContainText('时间段内还没有需求');
  await expect(card(page, '前置时间中位数')).toContainText('时间段内没有完成的需求');
  await expect(card(page, '迭代承诺')).toContainText('还没有在 Flower 里开始的迭代');
  await expect(card(page, '专项')).toContainText('时间段内没有包含本产品需求的专项');
  await expect(card(page, '评审')).toContainText('还没有在 Flower 里评审过的检查项');
  await expectNoPageOverflow(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expectNoPageOverflow(page);

  const ctx = await browser.newContext();
  const member = await ctx.newPage();
  await acceptInvite(member, request, { email: 'member@example.com', orgRole: 'member', name: '成员乙' });
  await member.goto('/acme/settings/dashboard');
  await expect(member.getByRole('heading', { name: '无权访问' })).toBeVisible();
  await expect(member.getByText('网盘')).toHaveCount(0);
  await member.goto('/acme/dashboard');
  await expect(card(member, '吞吐量（周均）')).toBeVisible();
  const denied = await member.request.get('/api/v1/orgs/acme/dashboard');
  expect(denied.status()).toBe(403);
  await ctx.close();
});

test('期末在制品：自定义时间段结束在今天之前时，在制品卡片改称「期末在制品」', async ({ page, request }) => {
  await seed(request);
  await login(page, OWNER.email, OWNER.password);
  const pan = (await json<{ products: Array<{ id: string }> }>(request.get('/api/v1/orgs/acme/products'))).products[0]!.id;
  await page.goto(`/acme/dashboard?product=${pan}`);
  await expect(card(page, '当前在制品')).toBeVisible();

  // 20 天前到 3 天前：期末（3 天前）需求二已在 5 天前完成、需求四 2 天前才开始，只剩需求三在进行中，与当前的 2 不同
  await page.goto(`/acme/dashboard?product=${pan}&from=${await day(-20)}&to=${await day(-3)}`);
  await expect(card(page, '期末在制品')).toBeVisible();
  await expect(cardValue(page, '期末在制品')).toHaveText('1');
  await expect(page.getByRole('region', { name: '当前在制品', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('开始日期')).toHaveValue(await day(-20));
  await expect(page.getByLabel('结束日期')).toHaveValue(await day(-3));
});

test('时间段不合法：显示原因，一键恢复默认时间段', async ({ page, request }) => {
  await seed(request);
  await login(page, OWNER.email, OWNER.password);
  const pan = (await json<{ products: Array<{ id: string }> }>(request.get('/api/v1/orgs/acme/products'))).products[0]!.id;

  // 开始晚于结束
  await page.goto(`/acme/dashboard?product=${pan}&from=${await day(-1)}&to=${await day(-5)}`);
  await expect(page.getByText('结束日期不能早于开始日期')).toBeVisible();
  await expect(card(page, '吞吐量（周均）')).toHaveCount(0);
  await page.getByRole('button', { name: '恢复默认时间段' }).click();
  await expect(page).not.toHaveURL(/from=/);
  await expect(card(page, '吞吐量（周均）')).toContainText('0.2 条/周');

  // 结束晚于今天
  await page.goto(`/acme/dashboard?product=${pan}&from=${await day(-5)}&to=${await day(3)}`);
  await expect(page.getByText('结束日期不能晚于今天')).toBeVisible();
  await page.getByRole('button', { name: '恢复默认时间段' }).click();
  await expect(card(page, '吞吐量（周均）')).toBeVisible();

  // 组织汇总同样
  await page.goto(`/acme/settings/dashboard?from=${await day(-1)}&to=${await day(-5)}`);
  await expect(page.getByText('结束日期不能早于开始日期')).toBeVisible();
  await expect(page.getByRole('table', { name: '各产品关键数字' })).toHaveCount(0);
  await page.getByRole('button', { name: '恢复默认时间段' }).click();
  await expect(page.getByRole('table', { name: '各产品关键数字' })).toBeVisible();
  await expect(page).not.toHaveURL(/from=/);
});

test('无权限：访客看不到产品，产品看板接口返回 404，组织汇总返回 403，页面不出现产品名', async ({ page, request, browser }) => {
  await setupInstance(request);
  const pan = await createProduct(request, '隐藏产品', 'HID');
  const ctx = await browser.newContext();
  const guest = await ctx.newPage();
  await acceptInvite(guest, request, { email: 'guest@example.com', orgRole: 'guest', name: '访客丙' });

  const product = await guest.request.get(`/api/v1/orgs/acme/products/${pan}/dashboard`);
  expect(product.status()).toBe(404);
  expect(await product.text()).not.toContain('隐藏产品');
  const summary = await guest.request.get('/api/v1/orgs/acme/dashboard');
  expect(summary.status()).toBe(403);
  expect(await summary.text()).not.toContain('隐藏产品');

  await guest.goto('/acme/settings/dashboard');
  await expect(guest.getByRole('heading', { name: '无权访问' })).toBeVisible();
  await expect(guest.getByText('隐藏产品')).toHaveCount(0);
  await guest.goto('/acme/dashboard');
  await expect(guest.getByRole('heading', { name: '看板', level: 1 })).toBeVisible();
  await expect(guest.getByText('还没有产品')).toBeVisible();
  await expect(guest.getByText('隐藏产品')).toHaveCount(0);
  await ctx.close();
  await page.close();
});
