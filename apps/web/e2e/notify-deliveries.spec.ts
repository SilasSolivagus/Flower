import { expect, test } from '@playwright/test';
import { startFakeWebhook } from '../test/fake-webhook';
import { resetDatabase } from './db';
import { createProduct, createRequirement, createWecomChannel, expectNoPageOverflow, json, login, ok, OWNER, setupInstance, tick } from './helpers';

let hook: Awaited<ReturnType<typeof startFakeWebhook>>;
test.beforeAll(async () => {
  hook = await startFakeWebhook();
});
test.afterAll(async () => {
  await hook.close();
});
test.beforeEach(() => {
  hook.reply(200, { errcode: 0, errmsg: 'ok' });
});

test('失败后显示「失败待重试」与响应；到时间后重试成功；重发；按状态筛选', async ({ page, request }) => {
  await resetDatabase();
  await setupInstance(request);
  await login(page, OWNER.email, OWNER.password);
  const productId = await createProduct(request);
  const channelId = await createWecomChannel(request, '研发群', hook.url('deliveries-0001'));
  await ok(request.post(`/api/v1/orgs/acme/products/${productId}/notification-rules`, { data: { name: '新需求提醒', eventTypes: ['requirement.created'], channelIds: [channelId] } }));
  hook.reply(200, { errcode: 93000, errmsg: 'invalid webhook url' });
  const req = await createRequirement(request, productId, '重试的需求');
  expect((await tick(request)).failed).toBe(1);

  await page.goto('/acme/settings/notifications?tab=deliveries');
  const row = page.getByRole('row', { name: /新需求提醒/ });
  await expect(row).toContainText('失败待重试');
  await expect(row).toContainText('93000');

  hook.reply(200, { errcode: 0, errmsg: 'ok' });
  expect((await tick(request, new Date(Date.now() + 31_000))).sent).toBe(1);
  await page.reload();
  await expect(row).toContainText('已发送');
  expect(JSON.stringify(hook.received.at(-1)!.body)).toContain(req.displayKey);

  await row.getByRole('button', { name: '重发' }).click();
  await expect(page.getByText('已加入发送队列')).toBeVisible();
  await expect(page.getByRole('row', { name: /新需求提醒/ })).toHaveCount(2);

  await page.getByRole('combobox', { name: '按状态筛选' }).click();
  await page.getByRole('option', { name: '待发送' }).click();
  await expect(page).toHaveURL(/status=pending/);
  await expect(page.getByRole('row', { name: /新需求提醒/ })).toHaveCount(1);
  await page.getByRole('button', { name: '清除筛选' }).click();
  await expect(page.getByRole('row', { name: /新需求提醒/ })).toHaveCount(2);
});

test('定时推送五次都失败：记录「已放弃」，所属定时推送告警并在两处标红', async ({ page, request }) => {
  await resetDatabase();
  await setupInstance(request);
  await login(page, OWNER.email, OWNER.password);
  const productId = await createProduct(request);
  const channelId = await createWecomChannel(request, '研发群', hook.url('alert-0001'));
  // 停用状态下只能手动执行，避免模拟时间时被当成到点
  const { schedule } = await json<{ schedule: { id: string } }>(
    request.post('/api/v1/orgs/acme/notification-schedules', { data: { productId, name: '研发日报', cron: '0 19 * * 1-5', source: 'overview_card', channelIds: [channelId], enabled: false } }),
  );
  await ok(request.post(`/api/v1/orgs/acme/notification-schedules/${schedule.id}/run`));
  hook.reply(500, { message: 'down' });
  const t0 = Date.now();
  for (const seconds of [0, 31, 152, 753, 4354]) await tick(request, new Date(t0 + seconds * 1000));

  await page.goto('/acme/settings/notifications?tab=deliveries');
  const row = page.getByRole('row', { name: /研发日报/ });
  await expect(row).toContainText('已放弃');
  await expect(row).toContainText('告警');
  await expect(row).toContainText('HTTP 500');
  await page.goto('/acme/settings/notifications?tab=schedules');
  await expect(page.getByRole('row', { name: /研发日报/ })).toContainText('告警 · 连续失败 1 次');
});

test('发送记录页在 1440 与 760 宽度下不横向滚动', async ({ page, request }) => {
  await resetDatabase();
  await setupInstance(request);
  await login(page, OWNER.email, OWNER.password);
  const channelId = await createWecomChannel(request, '一个名字比较长的研发群机器人', hook.url('layout-0003'));
  await ok(request.post(`/api/v1/orgs/acme/notification-channels/${channelId}/test`));
  for (const width of [1440, 760]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/acme/settings/notifications?tab=deliveries');
    await expect(page.getByRole('row', { name: /测试消息/ })).toBeVisible();
    await expectNoPageOverflow(page);
  }
});
