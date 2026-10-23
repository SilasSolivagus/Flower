import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { resetDatabase } from './db';
import { applyReviewWorkflow, createBrief, createIteration, createMember, createProduct, createRequirement, json, login, ok, OWNER, setupInstance } from './helpers';

/** 设 WB_SHOT=1 时把截图写到 docs/dux-e/：满负荷 1280、部分有数据 1280、满负荷 1536。 */
const SHOT_DIR = path.resolve(__dirname, '../../../docs/dux-e');
const LONG_ITERATION = '迭代0105名字很长用来确认进度百分比还在';
const REGIONS = ['我负责的需求', '等我跟进', '我的任务', '等我确认 检查项', '等我确认 简报', '未读评论'] as const;

type TaskRowMetric = { title: string; titleWidth: number; planRight: number; progressRight: number; rowRight: number };

/**
 * 标题可见宽度从元素自己算起，再被 overflow 不是 visible 的祖先裁切。
 * toBeVisible 在元素只剩几像素、甚至被父级裁掉时也会过。
 */
async function taskRowMetrics(region: Locator): Promise<TaskRowMetric[]> {
  const links = region.locator('ul > li > a');
  const count = await links.count();
  const rows: TaskRowMetric[] = [];
  for (let i = 0; i < count; i++) {
    rows.push(
      await links.nth(i).evaluate((row) => {
        const clips = (node: Element) => {
          const ox = getComputedStyle(node).overflowX;
          return ox === 'hidden' || ox === 'clip' || ox === 'scroll' || ox === 'auto';
        };
        const clippedWidth = (el: Element) => {
          const rect = el.getBoundingClientRect();
          let left = rect.left;
          let right = rect.right;
          let node: Element | null = el;
          while (node) {
            if (clips(node)) {
              const p = node.getBoundingClientRect();
              left = Math.max(left, p.left);
              right = Math.min(right, p.right);
            }
            node = node.parentElement;
          }
          return Math.max(0, right - left);
        };
        const title = row.querySelector('span.flex-1');
        const spans = [...row.querySelectorAll('span')];
        const plan = spans.find((s) => s.textContent === '未排期' || /^\d{4}-\d{2}-\d{2}$/.test(s.textContent ?? ''));
        const progress = spans.find((s) => /^\d+%$/.test(s.textContent ?? ''));
        if (!title || !plan || !progress) throw new Error('任务行缺少标题、计划日或进度');
        return {
          title: title.textContent ?? '',
          titleWidth: clippedWidth(title),
          planRight: plan.getBoundingClientRect().right,
          progressRight: progress.getBoundingClientRect().right,
          rowRight: row.getBoundingClientRect().right,
        };
      }),
    );
  }
  return rows;
}

function expectTaskRowsReadable(rows: TaskRowMetric[]) {
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(row.titleWidth, row.title).toBeGreaterThanOrEqual(64);
    expect(row.planRight, row.title).toBeLessThanOrEqual(row.rowRight + 1);
    expect(row.progressRight, row.title).toBeLessThanOrEqual(row.rowRight + 1);
  }
}

async function columnTops(page: Page) {
  const box = async (name: RegExp) => (await page.getByRole('region', { name }).boundingBox())!;
  const owned = await box(/我负责的需求/);
  const following = await box(/等我跟进/);
  const tasks = await box(/我的任务/);
  return { owned, following, tasks };
}

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

test('1280 两列按内容定高，任务标题可见宽度不少于 64px，1536 才三列', async ({ page, request, playwright }) => {
  const productId = await createProduct(request);
  const me = (await json<{ me: { memberId: string } }>(request.get('/api/v1/orgs/acme'))).me.memberId;
  const boss = await createMember(request, '老板乙');
  await applyReviewWorkflow(request, productId, boss);
  const iterationId = await createIteration(request, productId, LONG_ITERATION, '2026-01-05', '2026-01-16');
  const agent = (await json<{ member: { id: string } }>(request.post('/api/v1/orgs/acme/agents', { data: { displayName: '评审助手' } }))).member.id;
  const { token } = await json<{ token: string }>(
    request.post('/api/v1/orgs/acme/tokens', { data: { memberId: agent, name: '评论', scope: { products: 'all', access: 'write' } } }),
  );
  const bot = await playwright.request.newContext({ baseURL: 'http://localhost:3100', extraHTTPHeaders: { authorization: `Bearer ${token}` } });

  for (let i = 1; i <= 6; i++) {
    const req = await createRequirement(request, productId, i % 2 === 0 ? `上传链路第 ${i} 项，标题故意写长一点用来看窄卡里会不会被截断` : `上传提速 ${i}`);
    await ok(request.patch(`/api/v1/orgs/acme/requirements/${req.id}`, { data: { ownerMemberId: me } }));
    await ok(request.put(`/api/v1/orgs/acme/requirements/${req.id}/tracking`, { data: { tracking: true } }));
    await ok(request.post(`/api/v1/orgs/acme/requirements/${req.id}/progress`, { data: { body: `进展 ${i}`, nextStep: `下一步 ${i}`, followerMemberId: me } }));
    await ok(request.put(`/api/v1/orgs/acme/requirements/${req.id}/checks/feasibility`, { data: { state: 'passed' } }));
    await ok(bot.post(`/api/v1/orgs/acme/requirements/${req.id}/comments`, { data: { body: `请看一下 ${i}` } }));
    await ok(
      request.post('/api/v1/orgs/acme/tasks', {
        data: {
          iterationId,
          requirementId: req.id,
          title: i % 2 === 0 ? `联调任务 ${i} 名字也比较长` : `接口任务 ${i}`,
          assigneeMemberId: me,
          ...(i % 2 === 0 ? { planStart: '2026-01-06', planDays: 2 } : {}),
        },
      }),
    );
    const brief = await createBrief(request, productId, { title: `待确认简报 ${i}` });
    await ok(request.patch(`/api/v1/orgs/acme/briefs/${brief.id}`, { data: { deciderMemberId: me } }));
  }
  await bot.dispose();

  await login(page, OWNER.email, OWNER.password);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/acme');

  const tasks = page.getByRole('region', { name: /我的任务/ });
  const task = tasks.getByRole('link', { name: /接口任务 1/ });
  await expect(task.getByText('PAN-1', { exact: true })).toBeVisible();
  await expect(task.getByText(LONG_ITERATION, { exact: true })).toHaveAttribute('title', LONG_ITERATION);
  await expect(task.getByText('未排期', { exact: true })).toBeVisible();
  const progress = task.getByText('0%', { exact: true });
  await expect(progress).toBeVisible();
  expect((await progress.boundingBox())!.width).toBeGreaterThan(16);

  const at1280 = await columnTops(page);
  expect(Math.abs(at1280.owned.y - at1280.following.y)).toBeLessThan(1);
  expect(at1280.tasks.y).toBeGreaterThan(at1280.owned.y + at1280.owned.height - 1);
  expect(at1280.tasks.width).toBeGreaterThan(450);
  const rows1280 = await taskRowMetrics(tasks);
  expectTaskRowsReadable(rows1280);
  console.log(
    'TITLE_1280',
    JSON.stringify({ card: Math.round(at1280.tasks.width), rows: rows1280.map((r) => ({ title: r.title, w: Math.round(r.titleWidth) })) }),
  );

  const measure = async () => {
    const out: Record<string, { h: number; rows: number; textTop: number | null }> = {};
    for (const name of REGIONS) {
      const region = page.getByRole('region', { name: new RegExp(name) });
      const box = (await region.boundingBox())!;
      const empty = region.getByRole('link').filter({ hasText: /没有|暂无/ });
      const textTop = (await empty.count()) > 0 ? Math.round((await empty.first().boundingBox())!.y - box.y) : null;
      out[name] = { h: Math.round(box.height), rows: await region.locator('ul > li').count(), textTop };
    }
    return out;
  };

  const full = await measure();
  expect(full['等我确认 检查项'].h).toBeGreaterThan(full['等我确认 简报'].h + 40);
  expect(full['我负责的需求'].h).toBeGreaterThan(200);
  console.log('FULL', JSON.stringify(full));
  if (process.env.WB_SHOT === '1') {
    mkdirSync(SHOT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(SHOT_DIR, 'workbench-full-1280.png'), fullPage: true });
  }

  await page.setViewportSize({ width: 1536, height: 900 });
  const at1536 = await columnTops(page);
  expect(Math.abs(at1536.owned.y - at1536.following.y)).toBeLessThan(1);
  expect(Math.abs(at1536.owned.y - at1536.tasks.y)).toBeLessThan(1);
  const rows1536 = await taskRowMetrics(tasks);
  expectTaskRowsReadable(rows1536);
  console.log(
    'TITLE_1536',
    JSON.stringify({ card: Math.round(at1536.tasks.width), rows: rows1536.map((r) => ({ title: r.title, w: Math.round(r.titleWidth) })) }),
  );
  if (process.env.WB_SHOT === '1') await page.screenshot({ path: path.join(SHOT_DIR, 'workbench-full-1536.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });

  await page.route('**/api/v1/me/workbench', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    body.workbench.following = { total: 0, items: [] };
    body.workbench.signatures = { total: 0, items: [] };
    body.workbench.confirmations = { total: 0, items: [] };
    await route.fulfill({ response: res, json: body });
  });
  await page.reload();
  await expect(page.getByRole('region', { name: /等我跟进/ })).toContainText('没有等你跟进的条目');
  const partial = await measure();
  for (const name of ['等我跟进', '等我确认 检查项', '等我确认 简报'] as const) {
    expect(partial[name].h).toBeLessThan(120);
    expect(partial[name].textTop).toBeLessThan(80);
  }
  expect(partial['我负责的需求'].h).toBeGreaterThan(200);
  expect(partial['未读评论'].h).toBeGreaterThan(200);
  console.log('PARTIAL', JSON.stringify(partial));
  if (process.env.WB_SHOT === '1') await page.screenshot({ path: path.join(SHOT_DIR, 'workbench-partial-1280.png'), fullPage: true });
});
