import { expect, type Locator, type Page, test } from '@playwright/test';
import { resetDatabase } from './db';
import { createBrief, createDocument, createProduct, createRequirement, expectNoPageOverflow, json, login, memberRequest, ok, OWNER, setupInstance, tick } from './helpers';

const mention = (id: string, name: string) => `[@${name}](member:${id})`;

test('铃铛：被 @ 与被指派后显示未读数；面板按今天分组、按 @我 筛选；点击跳转并标为已读；全部标为已读', async ({ page, request }) => {
  await resetDatabase();
  await setupInstance(request);
  const productId = await createProduct(request);
  const login1 = await createRequirement(request, productId, '登录页改版');
  const share = await createRequirement(request, productId, '分享页');
  const zhang = await memberRequest(request, { email: 'zhang@example.com', name: '张三' });
  await ok(request.post(`/api/v1/orgs/acme/requirements/${login1.id}/comments`, { data: { body: `${mention(zhang.memberId, '张三')} 请看` } }));
  await ok(request.patch(`/api/v1/orgs/acme/requirements/${share.id}`, { data: { ownerMemberId: zhang.memberId } }));
  expect((await tick(request)).notified).toBe(2);

  await login(page, 'zhang@example.com', 'password123');
  await page.goto('/acme');
  await page.getByRole('button', { name: '通知，2 条未读' }).click();
  const panel = page.getByRole('dialog', { name: '通知' });
  await expect(panel.getByRole('region', { name: '今天' })).toBeVisible();
  await expect(panel.getByRole('button', { name: '林澄 把你设为需求负责人：PAN-2 分享页（未读）' })).toBeVisible();
  await panel.getByRole('tab', { name: '@我' }).click();
  const mentioned = panel.getByRole('button', { name: '林澄 在评论中 @ 了你：PAN-1 登录页改版（未读）' });
  await expect(mentioned).toBeVisible();
  await expect(panel.getByRole('button', { name: /把你设为需求负责人/ })).toHaveCount(0);
  await mentioned.click();
  await page.waitForURL('**/acme/requirements/PAN-1');
  await page.getByRole('button', { name: '通知，1 条未读' }).click();
  await page.getByRole('dialog', { name: '通知' }).getByRole('button', { name: '全部标为已读' }).click();
  await expect(page.getByRole('button', { name: '通知', exact: true })).toBeVisible();
  await zhang.ctx.dispose();
});

test('通知页：加载更多；按类型与已读状态筛选；点击跳转；1440 与 760 两种宽度不横向滚动', async ({ page, request }) => {
  await resetDatabase();
  await setupInstance(request);
  const productId = await createProduct(request);
  const login1 = await createRequirement(request, productId, '登录页改版');
  const share = await createRequirement(request, productId, '分享页');
  const zhang = await memberRequest(request, { email: 'zhang@example.com', name: '张三' });
  for (let i = 1; i <= 31; i++) {
    await ok(request.post(`/api/v1/orgs/acme/requirements/${login1.id}/comments`, { data: { body: `${mention(zhang.memberId, '张三')} 第 ${i} 条` } }));
  }
  await ok(request.patch(`/api/v1/orgs/acme/requirements/${share.id}`, { data: { ownerMemberId: zhang.memberId } }));
  expect((await tick(request)).notified).toBe(32);

  await login(page, 'zhang@example.com', 'password123');
  await page.goto('/acme/notifications');
  const list = page.getByRole('list', { name: '要你做的事' });
  await expect(list.getByRole('listitem')).toHaveCount(30);
  await expectNoPageOverflow(page);
  await page.getByRole('button', { name: '加载更多' }).click();
  await expect(list.getByRole('listitem')).toHaveCount(32);
  await expect(page.getByRole('button', { name: '加载更多' })).toHaveCount(0);
  await page.getByLabel('按类型筛选').click();
  await page.getByRole('option', { name: '被指派' }).click();
  await expect(page).toHaveURL(/kind=assigned/);
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await list.getByRole('button', { name: /把你设为需求负责人/ }).click();
  await page.waitForURL('**/acme/requirements/PAN-2');
  await page.goto('/acme/notifications?read=unread&kind=assigned');
  await expect(page.getByText('没有通知')).toBeVisible();

  await page.setViewportSize({ width: 760, height: 900 });
  await page.goto('/acme/notifications');
  await expect(list.getByRole('listitem').first()).toBeVisible();
  await expectNoPageOverflow(page);
  await page.getByRole('button', { name: /^通知，/ }).click();
  await expect(page.getByRole('dialog', { name: '通知' })).toBeVisible();
  await expectNoPageOverflow(page);
  await zhang.ctx.dispose();
});

/** 「已生成 PRD」这类中英短语在铃铛里占几行。拆开时大于 1。 */
async function phraseLineCount(root: Locator, phrase: string): Promise<number> {
  return root.evaluate((el, phrase) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const data = node.textContent ?? '';
      const i = data.indexOf(phrase);
      if (i >= 0) {
        const range = document.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + phrase.length);
        return range.getClientRects().length;
      }
      node = walker.nextNode();
    }
    return -1;
  }, phrase);
}

/** 通知页上的时间戳不能被点到：浮层或背后的不透明遮罩挡住。 */
async function pageTimestampsCovered(page: Page): Promise<void> {
  const result = await page.evaluate(() => {
    const backdrop = document.querySelector('[data-notification-backdrop]');
    const panel = document.querySelector('[data-slot="popover-content"]');
    if (!backdrop || !panel) return { ok: false, reason: '缺少遮罩或浮层' };
    const backdropStyle = getComputedStyle(backdrop);
    const opaque = backdropStyle.backgroundColor.replace(/\s/g, '').match(/^rgba?\(\d+,\d+,\d+(?:,1)?\)$/);
    if (!opaque || Number(backdropStyle.zIndex) >= Number(getComputedStyle(panel).zIndex)) {
      return { ok: false, reason: `遮罩 ${backdropStyle.backgroundColor} z=${backdropStyle.zIndex}，浮层 z=${getComputedStyle(panel).zIndex}` };
    }
    const stamp = /刚刚|\d+ 分钟前|\d+ 小时前|\d+ 天前|\d{2}-\d{2}/;
    const stamps = [...document.querySelectorAll('main span.font-mono')].filter((el) => stamp.test(el.textContent ?? ''));
    if (stamps.length === 0) return { ok: false, reason: '通知页上没有时间戳' };
    const misses: string[] = [];
    for (const el of stamps) {
      const r = el.getBoundingClientRect();
      const x = Math.min(window.innerWidth - 1, Math.max(0, r.left + r.width / 2));
      const y = Math.min(window.innerHeight - 1, Math.max(0, r.top + r.height / 2));
      const hit = document.elementFromPoint(x, y);
      const covered = !!hit?.closest('[data-notification-backdrop], [data-slot="popover-content"]');
      if (!covered) misses.push(`${(el.textContent ?? '').trim()} → ${hit?.tagName ?? 'null'}`);
    }
    return { ok: misses.length === 0, misses, count: stamps.length };
  });
  expect(result.ok, JSON.stringify(result)).toBe(true);
}

test('通知中心分区、任命职责、铃铛不折断关键词且未读角标不与背后时间戳重叠', async ({ page, request }) => {
  await resetDatabase();
  await setupInstance(request);
  const productId = await createProduct(request);
  const brief = await createBrief(request, productId, { title: '上传提速' });
  const zhang = await memberRequest(request, { email: 'zhang@example.com', name: '上游业务确认人张三' });
  await ok(request.patch(`/api/v1/orgs/acme/briefs/${brief.id}`, { data: { deciderMemberId: zhang.memberId } }));
  await ok(request.post(`/api/v1/orgs/acme/briefs/${brief.id}/convert`, { data: {} }));
  expect((await tick(request)).notified).toBeGreaterThanOrEqual(2);

  await login(page, 'zhang@example.com', 'password123');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/acme/notifications');
  const actions = page.getByRole('region', { name: '要你做的事' });
  const activity = page.getByRole('region', { name: '全部动态' });
  await expect(actions).toBeVisible();
  await expect(activity).toBeVisible();
  const actionBox = await actions.boundingBox();
  const activityBox = await activity.boundingBox();
  expect(actionBox && activityBox && actionBox.y < activityBox.y).toBeTruthy();
  await expect(actions.getByRole('button', { name: /请看问题是否说清、规则是否可执行/ })).toBeVisible();
  await expect(activity.getByRole('button', { name: /已生成 PRD/ })).toBeVisible();
  await expect(page.getByRole('main')).not.toContainText('决策人');
  await expectNoPageOverflow(page);
  await page.screenshot({ path: '/opt/cursor/artifacts/screenshots/notify-center-1280.png', fullPage: false });

  const bell = page.getByRole('button', { name: /条未读/ });
  const badge = bell.locator('span').filter({ hasText: /^\d+\+?$/ });
  await expect(badge).toBeVisible();
  const badgeBox = await badge.boundingBox();
  expect(badgeBox && badgeBox.width >= 16 && badgeBox.height >= 16).toBeTruthy();
  await bell.click();
  const panel = page.getByRole('dialog', { name: '通知' });
  await expect(panel).toBeVisible();
  const phrase = panel.locator('span.whitespace-nowrap', { hasText: '已生成 PRD' });
  await expect(phrase).toBeVisible();
  expect(await phraseLineCount(phrase, '已生成 PRD')).toBe(1);
  await pageTimestampsCovered(page);
  await expectNoPageOverflow(page);
  await page.screenshot({ path: '/opt/cursor/artifacts/screenshots/notify-bell-1280.png', fullPage: false });

  await page.setViewportSize({ width: 760, height: 900 });
  await expect(panel).toBeVisible();
  expect(await phraseLineCount(phrase, '已生成 PRD')).toBe(1);
  await pageTimestampsCovered(page);
  await expectNoPageOverflow(page);
  await page.screenshot({ path: '/opt/cursor/artifacts/screenshots/notify-bell-760.png', fullPage: false });
  await zhang.ctx.dispose();
});

test('关注按钮：手动关注后收到别人的评论；打开详情时通知标为已读；取消关注后不再收到；PRD 详情也有关注按钮', async ({ page, request }) => {
  await resetDatabase();
  await setupInstance(request);
  const productId = await createProduct(request);
  const req = await createRequirement(request, productId, '登录页改版');
  const doc = await createDocument(request, productId, { title: '登录 PRD' });
  const zhang = await memberRequest(request, { email: 'zhang@example.com', name: '张三' });
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/requirements/${req.displayKey}`);
  await page.getByRole('button', { name: '关注', exact: true }).click();
  await expect(page.getByRole('button', { name: '已关注' })).toHaveAttribute('title', '你手动关注了');
  // 先离开详情，通知生成后确认是未读，再打开详情
  await page.goto('/acme');

  await ok(zhang.ctx.post(`/api/v1/orgs/acme/requirements/${req.id}/comments`, { data: { body: '我来看看' } }));
  await tick(request);
  const mine = () => json<{ notifications: Array<{ body: string; readAt: string | null }> }>(request.get('/api/v1/orgs/acme/notifications'));
  expect((await mine()).notifications.map((n) => n.body)).toEqual(['发表了评论：我来看看']);
  expect((await mine()).notifications[0]!.readAt).toBeNull();
  await page.goto(`/acme/requirements/${req.displayKey}`);
  await expect(page.getByRole('button', { name: '已关注' })).toBeVisible();
  await expect.poll(async () => (await mine()).notifications[0]!.readAt).not.toBeNull();

  await page.getByRole('button', { name: '已关注' }).click();
  await expect(page.getByRole('button', { name: '关注', exact: true })).toBeVisible();
  await ok(zhang.ctx.post(`/api/v1/orgs/acme/requirements/${req.id}/comments`, { data: { body: '第二条' } }));
  await tick(request);
  expect((await mine()).notifications).toHaveLength(1);

  await page.goto(`/acme/documents/${doc.displayKey}`);
  await page.getByRole('button', { name: '关注', exact: true }).click();
  await expect(page.getByRole('button', { name: '已关注' })).toBeVisible();
  await zhang.ctx.dispose();
});
