import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { applyReviewWorkflow, createBrief, createIteration, createMember, createProduct, createRequirement, json, login, ok, OWNER, setupInstance } from './helpers';

/** 设 WB_SHOT=1 时把 1280 截图写到 docs/dux-e/，供 PR 直接打开。平时只断言卡高和字段可见。 */
const SHOT_DIR = path.resolve(__dirname, '../../../docs/dux-e');
const LONG_ITERATION = '迭代0105名字很长用来确认进度百分比还在';
const REGIONS = ['我负责的需求', '等我跟进', '我的任务', '等我确认 检查项', '等我确认 简报', '未读评论'] as const;

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

test('1280 满负荷卡片按内容定高，空块不被拉高，进度百分比仍可见', async ({ page, request, playwright }) => {
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
    const req = await createRequirement(request, productId, i % 2 === 0 ? `上传链路第 ${i} 项，标题故意写长一点用来看三列里会不会被截断` : `上传提速 ${i}`);
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

  const task = page.getByRole('region', { name: /我的任务/ }).getByRole('link', { name: /接口任务 1/ });
  await expect(task.getByText('PAN-1', { exact: true })).toBeVisible();
  await expect(task.getByText(LONG_ITERATION, { exact: true })).toBeVisible();
  await expect(task.getByText('未排期', { exact: true })).toBeVisible();
  const progress = task.getByText('0%', { exact: true });
  await expect(progress).toBeVisible();
  expect((await progress.boundingBox())!.width).toBeGreaterThan(16);

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
