import { inflateSync } from 'node:zlib';
import { writeFile } from 'node:fs/promises';
import { expect, type Page, test } from '@playwright/test';
import { resetDatabase } from './db';
import { acceptInvite, createBrief, createIteration, createProduct, createRequirement, createTask, json, login, ok, OWNER, readToken, setupInstance } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

test('工作项与任务列表是真页面，760 能看到标题和状态', async ({ page, request }) => {
  await login(page, OWNER.email, OWNER.password);
  await page.setViewportSize({ width: 760, height: 800 });
  await page.goto('/acme/work-items');
  await expect(page.getByRole('heading', { name: '工作项' })).toBeVisible();
  await expect(page.getByText('还没有工作项')).toBeVisible();
  const productId = await createProduct(request);
  await ok(request.post('/api/v1/orgs/acme/work-items', { data: { title: '协助客服', productId } }));
  await page.reload();
  await expect(page.getByRole('link', { name: '协助客服' })).toBeVisible();
  await expect(page.getByRole('table', { name: '工作项' })).toContainText('进行中');
  await page.goto('/acme/tracking');
  await page.getByRole('link', { name: '只看工作项' }).click();
  await expect(page).toHaveURL(/\/acme\/work-items$/);

  const iterationId = await createIteration(request, productId, '迭代一', '2026-10-01', '2026-10-14');
  await createTask(request, { title: '排期任务', productId, iterationId, assigneeMemberId: (await json<{ me: { memberId: string } }>(request.get('/api/v1/orgs/acme'))).me.memberId });
  await page.goto('/acme');
  // 「此刻迭代」空态是「查看全部迭代」，和「我的任务」的「查看全部」不是同一个链接。
  await page.getByRole('region', { name: /我的任务/ }).getByRole('link', { name: '查看全部', exact: true }).click();
  await expect(page).toHaveURL(/\/acme\/tasks$/);
  await expect(page.getByRole('heading', { name: '我的任务' })).toBeVisible();
  const table = page.getByRole('table', { name: '我的任务' });
  await expect(table.getByRole('link', { name: '排期任务' })).toBeVisible();
  await expect(table).toContainText('待开始');
});

test('需求标签可挂可卸，查看者没有添加', async ({ page, request, browser }) => {
  const productId = await createProduct(request);
  const req = await createRequirement(request, productId, '要打标的需求');
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/requirements/${req.displayKey}`);
  const tags = page.getByLabel('需求标签');
  await expect(tags).toContainText('暂无标签');
  await tags.getByRole('button', { name: '添加' }).click();
  await page.getByLabel('新标签名称').fill('体验');
  await page.getByRole('button', { name: '新建', exact: true }).click();
  await expect(tags.getByText('体验')).toBeVisible();
  await tags.getByRole('button', { name: '移除标签 体验' }).click();
  await expect(tags).toContainText('暂无标签');

  await page.goto('/acme/settings/requirement-tags');
  await page.getByLabel('新标签名称').fill('性能');
  await page.getByRole('button', { name: '添加' }).click();
  await expect(page.getByText('性能')).toBeVisible();

  const viewerPage = await browser.newPage();
  const viewer = await acceptInvite(viewerPage, request, { email: 'view@example.com', orgRole: 'member', name: '查看者' });
  await ok(request.put(`/api/v1/orgs/acme/products/${productId}/roles/${viewer}`, { data: { role: 'viewer' } }));
  await viewerPage.goto(`/acme/requirements/${req.displayKey}`);
  await expect(viewerPage.getByLabel('需求标签').getByRole('button', { name: '添加' })).toHaveCount(0);
  await viewerPage.close();
});

test('跟进批量改状态有确认，部分失败会说明', async ({ page, request }) => {
  const productId = await createProduct(request);
  await ok(request.post('/api/v1/orgs/acme/work-items', { data: { title: '可改状态', productId } }));
  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme/tracking');
  await page.getByRole('checkbox', { name: '选择 W-1' }).check();
  await page.getByRole('button', { name: '改状态' }).click();
  await expect(page.getByRole('dialog')).toContainText('改状态');
  await page.route('**/api/v1/orgs/acme/work-items/batch-status', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ updated: 0, failed: [{ id: 'x', reason: '无权或不存在' }] }),
    }),
  );
  await page.getByRole('button', { name: '确认' }).click();
  await expect(page.getByRole('status')).toContainText('成功 0 条 / 失败 1 条');
  await expect(page.getByRole('status')).toContainText('无权或不存在');
});

test('迭代按产品筛选时计数等于行数，专项只在全部里', async ({ page, request }) => {
  const pan = await createProduct(request, '网盘', 'PAN');
  const doc = await createProduct(request, '文档', 'DOC');
  await createIteration(request, pan, '网盘迭代', '2026-10-01', '2026-10-14');
  await createIteration(request, doc, '文档迭代', '2026-10-01', '2026-10-14');
  await ok(request.post('/api/v1/orgs/acme/iterations', { data: { type: 'special', name: '专项迭代', startDate: '2026-10-01', endDate: '2026-10-14' } }));
  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme/iterations');
  await expect(page.getByText('显示 3 条')).toBeVisible();
  await expect(page.getByRole('link', { name: '专项迭代' })).toBeVisible();
  await page.getByRole('combobox', { name: '产品' }).click();
  await page.getByRole('option', { name: '网盘' }).click();
  await expect(page.getByText('显示 1 条')).toBeVisible();
  await expect(page.getByRole('link', { name: '网盘迭代' })).toBeVisible();
  await expect(page.getByRole('link', { name: '专项迭代' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: '文档迭代' })).toHaveCount(0);
});

test('甘特窄屏列出标题和状态，只读 Token 有单独提示', async ({ page, request }) => {
  const productId = await createProduct(request);
  const iterationId = await createIteration(request, productId, '迭代一', '2026-10-01', '2026-10-14');
  await createTask(request, { title: '窄屏任务', productId, iterationId, status: 'doing' });
  await readToken(request);
  await login(page, OWNER.email, OWNER.password);
  await page.setViewportSize({ width: 760, height: 800 });
  await page.goto(`/acme/iterations/${iterationId}`);
  await page.getByRole('tab', { name: '甘特' }).click();
  const list = page.getByRole('list', { name: '任务' });
  await expect(list.getByRole('link', { name: '窄屏任务' })).toBeVisible();
  await expect(list).toContainText('进行中');
  await page.goto('/acme/settings/agents');
  await expect(page.getByText('只读 Token 不能新建或修改数据。')).toBeVisible();
});

test('失败简报可以去改，已删除文档不显示无权访问', async ({ page, request }, testInfo) => {
  const productId = await createProduct(request);
  const brief = await createBrief(request, productId, { title: '空白简报' });
  await login(page, OWNER.email, OWNER.password);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/acme/documents/${brief.displayKey}`);

  const gate = await json<{ gate: { items: Array<{ no: number; section: string | null }> } }>(request.get(`/api/v1/orgs/acme/briefs/${brief.id}/gate`));
  const region = page.getByRole('region', { name: '写 PRD 前检查' });
  const unlocated = gate.gate.items.filter((item) => !item.section);
  expect(unlocated.length).toBeGreaterThan(0);
  for (const item of unlocated) {
    await expect(region.getByRole('listitem', { name: `检查 ${item.no}`, exact: true }).getByRole('button', { name: /去改/ })).toHaveCount(0);
  }
  const located = gate.gate.items.filter((item) => item.section);
  expect(located.length).toBeGreaterThan(0);
  for (const item of located) {
    await expect(region.getByRole('listitem', { name: `检查 ${item.no}`, exact: true }).getByRole('button', { name: `去改「${item.section}」` })).toBeVisible();
  }

  const started = Date.now();
  await page.getByRole('button', { name: /去改「/ }).first().click();
  const target = page.locator('.brief-section-target');
  await expect(target).toBeVisible();
  const top = await target.evaluate((el) => el.getBoundingClientRect().top);
  expect(top).toBeGreaterThanOrEqual(56);
  const flash = await target.evaluate((el) => {
    const style = getComputedStyle(el);
    const raw = style.animationDuration.split(',')[0]?.trim() ?? '0s';
    const duration = raw.endsWith('ms') ? Number.parseFloat(raw) : Number.parseFloat(raw) * 1000;
    return { name: style.animationName, duration, background: style.backgroundColor };
  });
  expect(amberAlpha(flash.background), `目标节应为琥珀色，实际 ${flash.background}`).toBeGreaterThan(0.2);
  expect(flash.name).toContain('brief-section-flash');
  expect(flash.duration).toBeGreaterThanOrEqual(1500);
  const box = await target.boundingBox();
  expect(box).toBeTruthy();
  // 视口截图再按元素盒裁切。带 clip 的 CDP 截图在页面滚动后会偏到文档坐标。
  const shot = await captureViewport(page);
  await writeFile(testInfo.outputPath('brief-goto-1280.png'), shot);
  const ratio = amberPixelRatio(shot, box!);
  expect(ratio, `1280 高亮区域琥珀色像素占比 ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(0.4);
  const remain = 1500 - (Date.now() - started);
  if (remain > 0) await page.waitForTimeout(remain);
  await expect(target).toBeVisible();
  await expect(page).not.toHaveURL(/[?&]section=/);
  await expect(page).not.toHaveURL(/[?&]at=/);

  await page.goto(`/acme/documents/${brief.displayKey}?section=${encodeURIComponent(located[0]!.section!)}&at=1`);
  await expect(page.locator('.brief-section-target')).toBeVisible();
  await expect(page).not.toHaveURL(/[?&]section=/);
  await expect(page).not.toHaveURL(/[?&]at=/);

  await page.route('**/api/v1/orgs/acme/documents/PAN-PRD-404', (route) =>
    route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'not_found', message: '这份文档已删除，通知里的链接已失效' } }),
    }),
  );
  await page.goto('/acme/documents/PAN-PRD-404');
  await expect(page.getByText('这份文档已删除')).toBeVisible();
  await expect(page.getByText('通知里的链接已失效。')).toBeVisible();
  await expect(page.getByRole('heading', { name: '无权访问' })).toHaveCount(0);
});

/** 动画进行中的背景：接近 rgba(251, 191, 36, α)，α 足够才算琥珀还在。 */
function amberAlpha(color: string): number {
  const m = color.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)/);
  if (!m) return 0;
  const r = Number(m[1]);
  const g = Number(m[2]);
  const b = Number(m[3]);
  const a = m[4] === undefined ? 1 : Number(m[4]);
  const amber = r >= 200 && g >= 140 && g <= 230 && b <= 120;
  return amber ? a : 0;
}

/** 白底叠上 rgba(251, 191, 36, α) 之后的浅琥珀。α 从约 0.55 淡到仍可辨时都算。 */
function isAmberTint(r: number, g: number, b: number): boolean {
  return r >= 240 && g >= 190 && b <= 230 && g - b >= 18 && r + 8 >= g;
}

function amberPixelRatio(png: Buffer, box: { x: number; y: number; width: number; height: number }): number {
  const { width, height, data, channels } = decodePng(png);
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(width, Math.ceil(box.x + box.width));
  const y1 = Math.min(height, Math.ceil(box.y + box.height));
  let amber = 0;
  let total = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * width + x) * channels;
      total += 1;
      if (isAmberTint(data[o]!, data[o + 1]!, data[o + 2]!)) amber += 1;
    }
  }
  return total === 0 ? 0 : amber / total;
}

function decodePng(buf: Buffer): { width: number; height: number; data: Buffer; channels: number } {
  let offset = 8;
  const idat: Buffer[] = [];
  let width = 0;
  let height = 0;
  let colorType = 0;
  while (offset + 8 <= buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9]!;
      if (data[12] !== 0) throw new Error('不支持隔行 PNG');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') break;
    offset += 12 + len;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error(`不支持的 PNG 颜色类型 ${colorType}`);
  const inflated = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let src = 0;
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = inflated[src++]!;
    const row = inflated.subarray(src, src + stride);
    src += stride;
    const cur = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? cur[i - channels]! : 0;
      const up = prev[i]!;
      const upLeft = i >= channels ? prev[i - channels]! : 0;
      let v = row[i]!;
      if (filter === 1) v = (v + left) & 255;
      else if (filter === 2) v = (v + up) & 255;
      else if (filter === 3) v = (v + Math.floor((left + up) / 2)) & 255;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        const pr = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
        v = (v + pr) & 255;
      }
      cur[i] = v;
    }
    cur.copy(out, y * stride);
    prev = cur;
  }
  return { width, height, data: out, channels };
}

async function captureViewport(page: Page): Promise<Buffer> {
  const client = await page.context().newCDPSession(page);
  try {
    const { data } = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    return Buffer.from(data, 'base64');
  } finally {
    await client.detach();
  }
}
