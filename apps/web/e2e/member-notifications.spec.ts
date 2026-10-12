import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { createDocument, createProduct, createRequirement, expectNoPageOverflow, json, login, memberRequest, ok, OWNER, setupInstance, tick } from './helpers';

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
  const list = page.getByRole('list', { name: '通知列表' });
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

  await ok(zhang.ctx.post(`/api/v1/orgs/acme/requirements/${req.id}/comments`, { data: { body: '我来看看' } }));
  await tick(request);
  const mine = () => json<{ notifications: Array<{ body: string; readAt: string | null }> }>(request.get('/api/v1/orgs/acme/notifications'));
  expect((await mine()).notifications.map((n) => n.body)).toEqual(['发表了评论：我来看看']);
  await page.reload();
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
