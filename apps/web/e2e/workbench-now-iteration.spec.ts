import { expect, type Page, test } from '@playwright/test';
import { resetDatabase } from './db';
import { acceptInvite, createProduct, json, login, ok, OWNER, setupInstance } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

/** 服务端「今天」是上海自然日，与浏览器时区无关。 */
function shanghaiToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const next = new Date(Date.UTC(y!, m! - 1, d! + days));
  return next.toISOString().slice(0, 10);
}

async function activate(request: Parameters<typeof createProduct>[0], productId: string, name: string, start: string, end: string): Promise<string> {
  const id = (
    await json<{ iteration: { id: string } }>(
      request.post('/api/v1/orgs/acme/iterations', { data: { type: 'regular', productId, name, startDate: start, endDate: end } }),
    )
  ).iteration.id;
  await ok(request.post(`/api/v1/orgs/acme/iterations/${id}/status`, { data: { to: 'active' } }));
  return id;
}

function nowRegion(page: Page) {
  return page.getByRole('region', { name: '此刻迭代' });
}

async function visibleLetters(page: Page, name: string): Promise<number> {
  return nowRegion(page)
    .getByRole('link', { name })
    .evaluate((el) => {
    const style = getComputedStyle(el);
    const selfOverflow = el.scrollWidth > el.clientWidth + 0.5;
    let limit = el.getBoundingClientRect().right;
    if (selfOverflow && style.textOverflow.includes('ellipsis')) {
      const canvas = document.createElement('canvas').getContext('2d');
      if (canvas) {
        canvas.font = style.font;
        limit -= canvas.measureText('…').width;
      }
    }
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let n = 0;
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      const value = text.textContent ?? '';
      for (let i = 0; i < value.length; i++) {
        const ch = value[i] ?? '';
        if (/\s/u.test(ch)) continue;
        range.setStart(text, i);
        range.setEnd(text, i + 1);
        for (const glyph of range.getClientRects()) {
          if (glyph.width > 0 && glyph.right <= limit + 0.5) n += 1;
        }
      }
    }
    return n;
  });
}

test('有数据时此刻迭代在六块之上，概览来自工作台，不另请求甘特', async ({ page, request }) => {
  const today = shanghaiToday();
  const productId = await createProduct(request, '甲产品', 'AAA');
  const me = (await json<{ me: { memberId: string } }>(request.get('/api/v1/orgs/acme'))).me.memberId;
  const iterationId = await activate(request, productId, '甲此刻名称很长用来数可见字', addDays(today, -10), addDays(today, 10));
  const req = (
    await json<{ requirement: { id: string; displayKey: string } }>(
      request.post(`/api/v1/orgs/acme/products/${productId}/requirements`, { data: { title: '上传提速', ownerMemberId: me } }),
    )
  ).requirement;
  await ok(request.put(`/api/v1/orgs/acme/requirements/${req.id}/iteration`, { data: { iterationId } }));
  await ok(request.post(`/api/v1/orgs/acme/requirements/${req.id}/blockers`, { data: { description: '等接口' } }));
  await ok(
    request.post('/api/v1/orgs/acme/tasks', {
      data: { iterationId, requirementId: req.id, title: '接口联调', assigneeMemberId: me, planStart: today, planDays: 4 },
    }),
  );
  await ok(request.post('/api/v1/orgs/acme/tasks', { data: { iterationId, title: '没有需求的任务', assigneeMemberId: me, planStart: today, planDays: 2 } }));

  const ganttHits: string[] = [];
  page.on('request', (hit) => {
    if (hit.url().includes('/gantt')) ganttHits.push(hit.url());
  });
  await login(page, OWNER.email, OWNER.password);
  await page.waitForURL('**/acme');
  await page.setViewportSize({ width: 1280, height: 900 });
  const region = nowRegion(page);
  await expect(region.getByRole('link', { name: '甲此刻名称很长用来数可见字' })).toBeVisible();
  await expect(region.getByText('进行中', { exact: true })).toBeVisible();
  const row = region.locator('li').first().locator('div.h-10');
  await expect(row.getByText('进行中', { exact: true })).toHaveCount(1);
  await expect(row.locator('span', { hasText: '甲产品' })).not.toContainText('进行中');
  expect(await row.evaluate((el) => (el instanceof HTMLElement ? el.innerText : '').split('进行中').length - 1)).toBe(1);
  await page.screenshot({ path: '/opt/cursor/artifacts/sd01/now-iteration-1280.png' });
  await expect(region.locator('li').first().locator('p').first()).toContainText(/甲产品 · .+ · 进行中/);
  await expect(region.getByText('需求 0/1')).toBeVisible();
  await expect(region.getByText(/整体 \d+% · 理论 \d+% · 落后 \d+%/)).toBeVisible();
  await expect(region.getByText('活跃阻塞 1')).toBeVisible();
  expect(ganttHits).toEqual([]);

  const withReq = region.getByRole('link', { name: /接口联调/ });
  await expect(withReq).toHaveAttribute('href', `/acme/requirements/${req.displayKey}`);
  await expect(region.getByRole('link', { name: /没有需求的任务/ })).toHaveAttribute('href', `/acme/iterations/${iterationId}?tab=gantt`);
  await expect(region.getByRole('link', { name: '甘特' })).toHaveAttribute('href', `/acme/iterations/${iterationId}?tab=gantt`);

  for (const name of ['我负责的需求', '等我跟进', '我的任务', '等我确认 检查项', '等我确认 简报', '未读评论']) {
    await expect(page.getByRole('region', { name: new RegExp(name) })).toBeVisible();
  }
  const grid = page.locator('[class*="xl:grid-cols-2"]');
  const nowBox = (await region.boundingBox())!;
  const gridBox = (await grid.boundingBox())!;
  expect(nowBox.y).toBeLessThan(gridBox.y);

  await page.setViewportSize({ width: 390, height: 800 });
  await expect(row.locator('span', { hasText: '甲产品' })).toBeHidden();
  await expect(row.getByText('进行中', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 900 });

  await region.getByRole('link', { name: '甲此刻名称很长用来数可见字' }).click();
  await expect(page).toHaveURL(new RegExp(`/acme/iterations/${iterationId}$`));
});

test('没有迭代时是矮空态，六块空态仍在', async ({ page }) => {
  await login(page, OWNER.email, OWNER.password);
  await page.waitForURL('**/acme');
  await page.setViewportSize({ width: 1280, height: 900 });
  const region = nowRegion(page);
  const bar = region.locator('.border-dashed');
  await expect(bar).toContainText('还没有迭代。');
  await expect(bar.getByRole('link', { name: '查看迭代' })).toHaveAttribute('href', '/acme/iterations');
  expect((await bar.boundingBox())!.height).toBeLessThan(80);
  await expect(page.getByRole('group', { name: '工作台空态' }).getByRole('status')).toHaveText('没有需要你处理的条目。');
  await page.screenshot({ path: '/opt/cursor/artifacts/rw-p1/workbench-now-empty-1280.png' });
});

test('只有规划中的迭代时给出次要链，不选已完成', async ({ page, request }) => {
  const today = shanghaiToday();
  const productId = await createProduct(request, '规划产品', 'PLN');
  await ok(
    request.post('/api/v1/orgs/acme/iterations', {
      data: { type: 'regular', productId, name: '即将开始', startDate: addDays(today, -2), endDate: addDays(today, 8) },
    }),
  );
  const doneId = (
    await json<{ iteration: { id: string } }>(
      request.post('/api/v1/orgs/acme/iterations', {
        data: { type: 'regular', productId: await createProduct(request, '完成产品', 'DON'), name: '已经做完', startDate: addDays(today, -20), endDate: addDays(today, -1) },
      }),
    )
  ).iteration.id;
  await ok(request.post(`/api/v1/orgs/acme/iterations/${doneId}/status`, { data: { to: 'active' } }));
  await ok(request.post(`/api/v1/orgs/acme/iterations/${doneId}/status`, { data: { to: 'done' } }));

  await login(page, OWNER.email, OWNER.password);
  await page.waitForURL('**/acme');
  const region = nowRegion(page);
  await expect(region).toContainText('今天没有进行中、且起止日期包含今天的迭代。');
  await expect(region.getByRole('link', { name: '查看全部迭代' })).toHaveAttribute('href', '/acme/iterations');
  await expect(region.getByRole('link', { name: '规划中：即将开始' })).toBeVisible();
  await expect(region.getByText('已经做完')).toHaveCount(0);
});

test('多条按产品排列，默认展开第一条，名称在宽屏仍可读', async ({ page, request }) => {
  const today = shanghaiToday();
  const start = addDays(today, -10);
  const end = addDays(today, 10);
  const aaa = await createProduct(request, '甲产品', 'AAA');
  const zzz = await createProduct(request, '乙产品', 'ZZZ');
  await activate(request, zzz, '乙此刻', start, end);
  await activate(request, aaa, '甲此刻名称很长用来数可见字', start, end);
  const me = (await json<{ me: { memberId: string } }>(request.get('/api/v1/orgs/acme'))).me.memberId;
  await ok(request.post(`/api/v1/orgs/acme/products/${aaa}/requirements`, { data: { title: '占位需求', ownerMemberId: me } }));

  await login(page, OWNER.email, OWNER.password);
  await page.waitForURL('**/acme');
  const region = nowRegion(page);
  await expect(region.getByRole('link', { name: '甲此刻名称很长用来数可见字' })).toBeVisible();
  await expect(region.getByRole('link', { name: '乙此刻' })).toBeVisible();
  await expect(region.getByRole('button', { name: '收起 甲此刻名称很长用来数可见字' })).toHaveAttribute('aria-expanded', 'true');
  await expect(region.getByRole('button', { name: '展开 乙此刻' })).toHaveAttribute('aria-expanded', 'false');
  await region.getByRole('button', { name: '展开 乙此刻' }).click();
  await expect(region.getByRole('button', { name: '收起 乙此刻' })).toHaveAttribute('aria-expanded', 'true');
  await expect(region.getByRole('button', { name: '展开 甲此刻名称很长用来数可见字' })).toHaveAttribute('aria-expanded', 'false');

  const shots: Array<[number, string, 2 | 3]> = [
    [1280, 'workbench-now-1280.png', 2],
    [1440, 'workbench-now-1440.png', 2],
    [1536, 'workbench-now-1536.png', 2],
    [1920, 'workbench-now-1920.png', 3],
  ];
  const grid = page.locator('[class*="xl:grid-cols-2"]');
  for (const [width, file, columns] of shots) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(async () => (await grid.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').filter(Boolean).length))).toBe(columns);
    const nowBox = (await region.boundingBox())!;
    const gridBox = (await grid.boundingBox())!;
    expect(nowBox.y).toBeLessThan(gridBox.y);
    await page.screenshot({ path: `/opt/cursor/artifacts/rw-p1/${file}` });
  }
  const letters = await visibleLetters(page, '甲此刻名称很长用来数可见字');
  expect(letters).toBeGreaterThanOrEqual(8);
});

test('空心迭代不铺四张概览卡', async ({ page, request }) => {
  const today = shanghaiToday();
  const productId = await createProduct(request, '空心产品', 'HOL');
  await activate(request, productId, '空心此刻', addDays(today, -3), addDays(today, 3));
  await login(page, OWNER.email, OWNER.password);
  await page.waitForURL('**/acme');
  const region = nowRegion(page);
  await expect(region.getByText('添加任务并填写开始日期后，这里会汇总整体、理论、落后和遗留。')).toBeVisible();
  await expect(region.getByRole('group', { name: '整体进度' })).toHaveCount(0);
  await expect(region.getByRole('link', { name: '去甘特' })).toBeVisible();
});

test('访客看不到不可见产品的迭代', async ({ page, request }) => {
  const today = shanghaiToday();
  const start = addDays(today, -5);
  const end = addDays(today, 5);
  const visible = await createProduct(request, '甲产品', 'AAA');
  const hidden = await createProduct(request, '隐产品', 'HID');
  await activate(request, visible, '甲此刻', start, end);
  await activate(request, hidden, '机密迭代', start, end);
  const guestId = await acceptInvite(page, request, { email: 'guest-now@example.com', orgRole: 'guest', name: '访客此刻' });
  await ok(request.put(`/api/v1/orgs/acme/products/${visible}/roles/${guestId}`, { data: { role: 'viewer' } }));
  await page.goto('/acme');
  const region = nowRegion(page);
  await expect(region.getByRole('link', { name: '甲此刻' })).toBeVisible();
  await expect(page.getByText('机密迭代')).toHaveCount(0);
  await expect(page.getByText('加载工作台失败')).toHaveCount(0);
});
