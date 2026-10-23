import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, type APIRequestContext, type APIResponse, type Locator, type Page, test } from '@playwright/test';
import { resetDatabase } from './db';
import { applyReviewWorkflow, createBrief, createIteration, createMember, createProduct, createRequirement, json, login, ok, OWNER, setupInstance } from './helpers';

/** 设 WB_SHOT=1 时把截图写到 docs/dux-e/：满负荷 1280、1440、1536、1920、1920 多组织，以及部分有数据 1280。 */
const SHOT_DIR = path.resolve(__dirname, '../../../docs/dux-e');
const LONG_ITERATION = '迭代0105名字很长用来确认进度百分比还在';
const LONG_ORG = '华东区域联合交付与质量保障中心';
const REGIONS = ['我负责的需求', '等我跟进', '我的任务', '等我确认 检查项', '等我确认 简报', '未读评论'] as const;
/** 宽度阈值留 0.5px，避免亚像素把刚好达标的量测打成失败。 */
const SLACK = 0.5;
const TITLE_CHARS = 8;
const ITERATION_WIDTH = 32;

type TaskRowMetric = {
  title: string;
  titleChars: number;
  titleLetters: number;
  titleShown: string;
  titleWidth: number;
  iterationWidth: number;
  planWidth: number;
  planFull: number;
  progressWidth: number;
  progressFull: number;
};

type Bot = { post: (url: string, opts: { data: unknown }) => Promise<APIResponse>; dispose: () => Promise<void> };

/**
 * 可见宽是元素边框盒与卡片可视区、裁切父级的交集。
 * 标题字数不含空格；省略号盖住的字形、以及大半落在裁切区外的字形都不算。
 * 可见宽不能靠标题自己的 min-w 单独过关。
 */
async function taskRowMetrics(region: Locator): Promise<TaskRowMetric[]> {
  return region.locator('ul > li > a').evaluateAll((rows) => {
    const clips = (node: Element) => {
      const ox = getComputedStyle(node).overflowX;
      return ox === 'hidden' || ox === 'clip' || ox === 'scroll' || ox === 'auto';
    };
    const paddingEdge = (node: Element) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      const left = rect.left + (Number.parseFloat(style.borderLeftWidth) || 0);
      const right = rect.right - (Number.parseFloat(style.borderRightWidth) || 0);
      return { left, right };
    };
    const visibleSpan = (el: Element) => {
      const rect = el.getBoundingClientRect();
      let left = rect.left;
      let right = rect.right;
      const card = el.closest('section');
      if (!card) throw new Error('任务行不在卡片里');
      const bounds: Element[] = [card];
      let node: Element | null = el;
      while (node) {
        if (clips(node)) bounds.push(node);
        node = node.parentElement;
      }
      for (const bound of bounds) {
        const edge = paddingEdge(bound);
        left = Math.max(left, edge.left);
        right = Math.min(right, edge.right);
      }
      return { left, right, width: Math.max(0, right - left), full: rect.width };
    };
    const isLetter = (ch: string) => !/\s/u.test(ch);
    const lettersOf = (value: string) => Array.from(value).filter(isLetter).join('');
    const visibleLetters = (el: Element, left: number, right: number) => {
      const style = getComputedStyle(el);
      let limit = right;
      if (style.textOverflow.includes('ellipsis') && el.scrollWidth > el.clientWidth + 0.5) {
        const canvas = document.createElement('canvas').getContext('2d');
        if (canvas) {
          canvas.font = style.font;
          const ellipsis = canvas.measureText('…').width;
          const pad = Number.parseFloat(style.paddingRight) || 0;
          const border = Number.parseFloat(style.borderRightWidth) || 0;
          limit = Math.min(limit, el.getBoundingClientRect().right - border - pad - ellipsis);
        }
      }
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      let shown = '';
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        const value = text.textContent ?? '';
        for (let i = 0; i < value.length; i++) {
          const ch = value[i] ?? '';
          if (!isLetter(ch)) continue;
          range.setStart(text, i);
          range.setEnd(text, i + 1);
          for (const glyph of range.getClientRects()) {
            if (glyph.width <= 0 || glyph.height <= 0) continue;
            const overlap = Math.min(glyph.right, limit) - Math.max(glyph.left, left);
            if (overlap >= glyph.width / 2) {
              shown += ch;
              break;
            }
          }
        }
      }
      return shown;
    };
    return rows.map((row) => {
      const title = row.querySelector('span.flex-1');
      const iteration = row.querySelector('span.max-w-24');
      const spans = [...row.querySelectorAll('span')];
      const plan = spans.find((span) => span.textContent === '未排期' || /^\d{4}-\d{2}-\d{2}$/.test(span.textContent ?? ''));
      const progress = spans.find((span) => /^\d+%$/.test(span.textContent ?? ''));
      if (!title || !iteration || !plan || !progress) throw new Error('任务行缺少标题、迭代、计划日或进度');
      const titleBox = visibleSpan(title);
      const iterationBox = visibleSpan(iteration);
      const planBox = visibleSpan(plan);
      const progressBox = visibleSpan(progress);
      const titleText = title.textContent ?? '';
      const titleShown = visibleLetters(title, titleBox.left, titleBox.right);
      return {
        title: titleText,
        titleChars: Array.from(titleShown).length,
        titleLetters: lettersOf(titleText).length,
        titleShown,
        titleWidth: titleBox.width,
        iterationWidth: iterationBox.width,
        planWidth: planBox.width,
        planFull: planBox.full,
        progressWidth: progressBox.width,
        progressFull: progressBox.full,
      };
    });
  });
}

function expectTaskRowsReadable(rows: TaskRowMetric[]) {
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    const need = Math.min(TITLE_CHARS, row.titleLetters);
    expect(row.titleChars, `${row.title} 可见字 ${row.titleChars}（${row.titleShown}），全文非空格 ${row.titleLetters}，可见宽 ${row.titleWidth.toFixed(1)}px`).toBeGreaterThanOrEqual(need);
    expect(row.iterationWidth, `${row.title} 迭代名`).toBeGreaterThanOrEqual(ITERATION_WIDTH - SLACK);
    expect(row.planWidth, `${row.title} 计划日`).toBeGreaterThanOrEqual(row.planFull - SLACK);
    expect(row.progressWidth, `${row.title} 进度`).toBeGreaterThanOrEqual(row.progressFull - SLACK);
  }
}

function noteMetrics(label: string, cardWidth: number, rows: TaskRowMetric[]) {
  const description = JSON.stringify({
      card: Math.round(cardWidth),
      rows: rows.map((row) => ({
        title: row.title,
        chars: row.titleChars,
        letters: row.titleLetters,
        shown: row.titleShown,
        titleWidth: Number(row.titleWidth.toFixed(1)),
        iterationWidth: Number(row.iterationWidth.toFixed(1)),
        planWidth: Number(row.planWidth.toFixed(1)),
        planFull: Number(row.planFull.toFixed(1)),
        progressWidth: Number(row.progressWidth.toFixed(1)),
        progressFull: Number(row.progressFull.toFixed(1)),
      })),
  });
  test.info().annotations.push({ type: label, description });
}

async function columnTops(page: Page) {
  const box = async (name: RegExp) => (await page.getByRole('region', { name }).boundingBox())!;
  return { owned: await box(/我负责的需求/), following: await box(/等我跟进/), tasks: await box(/我的任务/) };
}

function expectColumns(tops: { owned: { y: number; height: number }; following: { y: number }; tasks: { y: number } }, columns: 2 | 3) {
  expect(Math.abs(tops.owned.y - tops.following.y)).toBeLessThan(1);
  if (columns === 2) expect(tops.tasks.y).toBeGreaterThan(tops.owned.y + tops.owned.height - 1);
  else expect(Math.abs(tops.owned.y - tops.tasks.y)).toBeLessThan(1);
}

async function shot(page: Page, name: string) {
  if (process.env.WB_SHOT !== '1') return;
  mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOT_DIR, name), fullPage: true });
}

async function seedFullWorkbench(request: APIRequestContext, playwright: { request: { newContext(opts: { baseURL: string; extraHTTPHeaders: Record<string, string> }): Promise<Bot> } }) {
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
}

async function openWorkbench(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  if (!page.url().includes('/acme')) {
    await login(page, OWNER.email, OWNER.password);
    await page.goto('/acme');
  }
  await page.evaluate(() => document.fonts.ready);
  const tasks = page.getByRole('region', { name: /我的任务/ });
  await expect(tasks.getByRole('link').first()).toBeVisible();
  return tasks;
}

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

test('1280 与 1536 两列，任务标题可见字不少于全文与 8 的较小值', async ({ page, request, playwright }) => {
  await seedFullWorkbench(request, playwright);
  await login(page, OWNER.email, OWNER.password);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/acme');
  await page.evaluate(() => document.fonts.ready);

  const tasks = page.getByRole('region', { name: /我的任务/ });
  const task = tasks.getByRole('link', { name: /接口任务 1/ });
  await expect(task.getByText('PAN-1', { exact: true })).toBeVisible();
  const iteration = task.getByText(LONG_ITERATION, { exact: true });
  await expect(iteration).toBeVisible();
  await expect(iteration).toHaveAttribute('title', LONG_ITERATION);
  await expect(task.getByText('未排期', { exact: true })).toBeVisible();
  const progress = task.getByText('0%', { exact: true });
  await expect(progress).toBeVisible();
  expect((await progress.boundingBox())!.width).toBeGreaterThan(16);

  const at1280 = await columnTops(page);
  expectColumns(at1280, 2);
  expect(at1280.tasks.width).toBeGreaterThan(450);
  const rows1280 = await taskRowMetrics(tasks);
  expectTaskRowsReadable(rows1280);
  noteMetrics('TITLE_1280', at1280.tasks.width, rows1280);

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
  await shot(page, 'workbench-full-1280.png');

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => document.fonts.ready);
  const at1440 = await columnTops(page);
  expectColumns(at1440, 2);
  const rows1440 = await taskRowMetrics(tasks);
  expectTaskRowsReadable(rows1440);
  noteMetrics('TITLE_1440', at1440.tasks.width, rows1440);
  await shot(page, 'workbench-full-1440.png');

  await page.setViewportSize({ width: 1536, height: 900 });
  await page.evaluate(() => document.fonts.ready);
  const at1536 = await columnTops(page);
  const rows1536 = await taskRowMetrics(tasks);
  expectTaskRowsReadable(rows1536);
  expectColumns(at1536, 2);
  noteMetrics('TITLE_1536', at1536.tasks.width, rows1536);
  await shot(page, 'workbench-full-1536.png');

  await page.setViewportSize({ width: 1920, height: 900 });
  await page.evaluate(() => document.fonts.ready);
  const at1920 = await columnTops(page);
  expectColumns(at1920, 3);
  const rows1920 = await taskRowMetrics(tasks);
  expectTaskRowsReadable(rows1920);
  noteMetrics('TITLE_1920', at1920.tasks.width, rows1920);
  await shot(page, 'workbench-full-1920.png');

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
  await shot(page, 'workbench-partial-1280.png');
});

test('多组织徽标下，1536 与 1920 的任务进度不被裁切', async ({ page, request, playwright }) => {
  await seedFullWorkbench(request, playwright);
  await ok(request.post('/api/v1/orgs', { data: { name: '第二组织', slug: 'second' } }));
  const tasks = await openWorkbench(page, 1536);
  const at1536 = await columnTops(page);
  expectColumns(at1536, 2);
  const rows1536 = await taskRowMetrics(tasks);
  expectTaskRowsReadable(rows1536);
  noteMetrics('BADGE_1536', at1536.tasks.width, rows1536);
  await expect(tasks.locator('ul > li > a').first()).toContainText('测试组织');

  await page.setViewportSize({ width: 1920, height: 900 });
  await page.evaluate(() => document.fonts.ready);
  const at1920 = await columnTops(page);
  expectColumns(at1920, 3);
  const rows1920 = await taskRowMetrics(tasks);
  expectTaskRowsReadable(rows1920);
  noteMetrics('BADGE_1920', at1920.tasks.width, rows1920);
});

test('单组织、侧栏展开、1920 任务标题、迭代和进度可读', async ({ page, request, playwright }) => {
  await seedFullWorkbench(request, playwright);
  const tasks = await openWorkbench(page, 1920);
  await expect(page.getByTestId('org-nav')).toHaveAttribute('data-collapsed', 'false');
  await expect(page.getByRole('button', { name: '收起侧栏' })).toBeVisible();
  expectColumns(await columnTops(page), 3);
  const scheduled = tasks.getByRole('link', { name: /联调任务 2/ });
  await expect(scheduled.getByText('PAN-2', { exact: true })).toBeVisible();
  await expect(scheduled.getByText(LONG_ITERATION, { exact: true })).toBeVisible();
  await expect(scheduled.getByText('2026-01-06', { exact: true })).toBeVisible();
  await expect(scheduled.getByText('100%', { exact: true })).toBeVisible();
  const rows = await taskRowMetrics(tasks);
  expectTaskRowsReadable(rows);
  noteMetrics('SOLO_1920', (await columnTops(page)).tasks.width, rows);
});

test('多组织长名称、1920 任务标题可读', async ({ page, request, playwright }) => {
  await seedFullWorkbench(request, playwright);
  await ok(request.patch('/api/v1/orgs/acme', { data: { name: LONG_ORG } }));
  await ok(request.post('/api/v1/orgs', { data: { name: '华北平台与客户成功长期协同组', slug: 'north' } }));
  const tasks = await openWorkbench(page, 1920);
  await expect(page.getByTestId('org-nav')).toHaveAttribute('data-collapsed', 'false');
  expectColumns(await columnTops(page), 3);
  const scheduled = tasks.getByRole('link', { name: /联调任务 2/ });
  const badge = scheduled.getByTitle(LONG_ORG);
  await expect(badge).toBeVisible();
  await expect(scheduled.getByText('PAN-2', { exact: true })).toBeVisible();
  await expect(scheduled.getByText(LONG_ITERATION, { exact: true })).toBeVisible();
  await expect(scheduled.getByText('2026-01-06', { exact: true })).toBeVisible();
  const rows = await taskRowMetrics(tasks);
  expectTaskRowsReadable(rows);
  noteMetrics('LONG_ORG_1920', (await columnTops(page)).tasks.width, rows);
  await shot(page, 'workbench-full-1920-multiorg.png');
});

test('侧栏收起后 1536 仍是两列，任务行可读，页头仍能收起', async ({ page, request, playwright }) => {
  await seedFullWorkbench(request, playwright);
  const tasks = await openWorkbench(page, 1536);
  await page.getByRole('button', { name: '收起侧栏' }).click();
  const nav = page.getByTestId('org-nav');
  await expect(nav).toHaveAttribute('data-collapsed', 'true');
  await expect.poll(async () => (await nav.boundingBox())!.width).toBeLessThanOrEqual(56);
  const at1536 = await columnTops(page);
  expectColumns(at1536, 2);
  const rows1536 = await taskRowMetrics(tasks);
  expectTaskRowsReadable(rows1536);
  noteMetrics('RAIL_1536', at1536.tasks.width, rows1536);

  const about = page.getByRole('button', { name: '了解更多' });
  await about.click();
  const collapse = page.getByRole('button', { name: '收起', exact: true });
  await expect(collapse).toHaveAttribute('aria-expanded', 'true');
  await collapse.click();
  await expect(about).toHaveAttribute('aria-expanded', 'false');
  await expect(about).toHaveText('了解更多');

  await page.setViewportSize({ width: 1920, height: 900 });
  await page.evaluate(() => document.fonts.ready);
  const at1920 = await columnTops(page);
  expectColumns(at1920, 3);
  const rows1920 = await taskRowMetrics(tasks);
  expectTaskRowsReadable(rows1920);
  noteMetrics('RAIL_1920', at1920.tasks.width, rows1920);
});
