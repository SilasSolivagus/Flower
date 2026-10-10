import { expect, test } from '@playwright/test';
import { startFakeWebhook } from '../test/fake-webhook';
import { resetDatabase } from './db';
import { createProduct, createRequirement, createWecomChannel, expectNoPageOverflow, login, ok, OWNER, setupInstance, tick } from './helpers';

let hook: Awaited<ReturnType<typeof startFakeWebhook>>;
test.beforeAll(async () => {
  hook = await startFakeWebhook();
});
test.afterAll(async () => {
  await hook.close();
});

test('产品设置「推送」：新建即时规则；新建需求后驱动发送，假接收端收到 markdown', async ({ page, request }) => {
  await resetDatabase();
  await setupInstance(request);
  await login(page, OWNER.email, OWNER.password);
  const productId = await createProduct(request);
  await createWecomChannel(request, '研发群', hook.url('rules-0001'));
  await page.goto(`/acme/settings/products/${productId}`);
  await page.getByRole('tab', { name: '推送' }).click();
  await expect(page.getByText('还没有事件规则')).toBeVisible();
  await page.getByRole('button', { name: '新建规则' }).click();
  await page.getByLabel('规则名称').fill('新需求提醒');
  await page.getByRole('checkbox', { name: '事件：新建需求' }).click();
  await page.getByRole('checkbox', { name: '通道：研发群' }).click();
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByRole('row', { name: /新需求提醒/ })).toContainText('研发群');

  const req = await createRequirement(request, productId, '端到端需求');
  const before = hook.received.length;
  expect((await tick(request)).sent).toBe(1);
  expect(hook.received.length).toBe(before + 1);
  const msg = hook.received.at(-1)!.body as { msgtype: string; markdown: { content: string } };
  expect(msg.msgtype).toBe('markdown');
  expect(msg.markdown.content).toContain(`${req.displayKey} 端到端需求`);
});

test('定时推送：产品设置里新建「新需求」并立即执行；组织设置里立即执行概览卡片', async ({ page, request }) => {
  await resetDatabase();
  await setupInstance(request);
  await login(page, OWNER.email, OWNER.password);
  const productId = await createProduct(request);
  const channelId = await createWecomChannel(request, '研发群', hook.url('schedules-0001'));
  await createRequirement(request, productId, '今天的新需求');
  await page.goto(`/acme/settings/products/${productId}`);
  await page.getByRole('tab', { name: '推送' }).click();
  await page.getByRole('button', { name: '新建定时推送' }).click();
  await page.getByLabel('名称', { exact: true }).fill('每日新需求');
  await page.getByLabel('内容来源').click();
  await page.getByRole('option', { name: '新需求' }).click();
  await page.getByLabel('定时规则').fill('30 9 * * *');
  await page.getByRole('checkbox', { name: '通道：研发群' }).click();
  await page.getByRole('button', { name: '保存' }).click();
  const row = page.getByRole('row', { name: /每日新需求/ });
  await expect(row).toContainText('30 9 * * *');
  await row.getByRole('button', { name: '立即执行' }).click();
  await page.getByRole('button', { name: '执行', exact: true }).click();
  await expect(page.getByText('已生成 1 条待发记录，几秒内发送')).toBeVisible();
  await tick(request);
  const md = hook.received.at(-1)!.body as { markdown: { content: string } };
  expect(md.markdown.content).toMatch(/^# 📋 \d{1,2}\/\d{1,2} 新增需求/);
  expect(md.markdown.content).toContain('今天的新需求');

  await ok(request.post('/api/v1/orgs/acme/notification-schedules', { data: { productId, name: '研发日报', cron: '0 19 * * 1-5', source: 'overview_card', channelIds: [channelId] } }));
  await page.goto('/acme/settings/notifications?tab=schedules');
  const daily = page.getByRole('row', { name: /研发日报/ });
  await expect(daily).toContainText('网盘');
  await daily.getByRole('button', { name: '立即执行' }).click();
  await page.getByRole('button', { name: '执行', exact: true }).click();
  await expect(page.getByText('已生成 1 条待发记录，几秒内发送')).toBeVisible();
  await tick(request);
  expect(hook.received.at(-1)!.body).toMatchObject({ msgtype: 'template_card', template_card: { card_type: 'text_notice' } });
});

test('产品「推送」页签与组织「定时推送」页签在 1440 与 760 宽度下不横向滚动', async ({ page, request }) => {
  await resetDatabase();
  await setupInstance(request);
  await login(page, OWNER.email, OWNER.password);
  const productId = await createProduct(request);
  const channelId = await createWecomChannel(request, '一个名字比较长的研发群机器人', hook.url('layout-0002'));
  await ok(request.post(`/api/v1/orgs/acme/products/${productId}/notification-rules`, { data: { name: '需求状态变化提醒', eventTypes: ['requirement.state_changed', 'requirement.created'], channelIds: [channelId] } }));
  await ok(request.post('/api/v1/orgs/acme/notification-schedules', { data: { productId, name: '工作日研发日报', cron: '0 19 * * 1-5', source: 'overview_card', channelIds: [channelId] } }));
  for (const width of [1440, 760]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/acme/settings/products/${productId}`);
    await page.getByRole('tab', { name: '推送' }).click();
    await expect(page.getByRole('row', { name: /需求状态变化提醒/ })).toBeVisible();
    await expectNoPageOverflow(page);
    await page.goto('/acme/settings/notifications?tab=schedules');
    await expect(page.getByRole('row', { name: /工作日研发日报/ })).toBeVisible();
    await expectNoPageOverflow(page);
  }
});
