import { expect, test } from '@playwright/test';
import { startFakeWebhook } from '../test/fake-webhook';
import { resetDatabase } from './db';
import { expectNoPageOverflow, login, OWNER, setupInstance } from './helpers';

let hook: Awaited<ReturnType<typeof startFakeWebhook>>;
test.beforeAll(async () => {
  hook = await startFakeWebhook();
});
test.afterAll(async () => {
  await hook.close();
});

test('登记企微通道、确认后发送测试消息、修改（地址留空不变）、停用后不能测试；页面不显示明文地址', async ({ page, request }) => {
  await resetDatabase();
  await setupInstance(request);
  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme/settings/notifications');
  await expect(page.getByText('还没有通道')).toBeVisible();
  await page.getByRole('button', { name: '登记通道' }).click();
  await page.getByLabel('名称', { exact: true }).fill('研发群');
  await page.getByLabel('所属群').fill('研发');
  await page.getByLabel('机器人地址').fill(hook.url('e2e-demo-0001'));
  await page.getByRole('button', { name: '保存' }).click();
  const row = page.getByRole('row', { name: /研发群/ });
  await expect(row).toContainText('…/send?key=****0001');
  await expect(page.getByText('e2e-demo-0001')).toHaveCount(0);

  const before = hook.received.length;
  await row.getByRole('button', { name: '测试' }).click();
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('测试消息已发送')).toBeVisible();
  expect(hook.received.length).toBe(before + 1);
  expect(hook.received.at(-1)!.body).toMatchObject({ msgtype: 'text' });

  await row.getByRole('button', { name: '修改' }).click();
  await expect(page.getByLabel('机器人地址')).toHaveValue('');
  await page.getByLabel('名称', { exact: true }).fill('研发群 A');
  await page.getByRole('button', { name: '保存' }).click();
  const renamed = page.getByRole('row', { name: /研发群 A/ });
  await expect(renamed).toContainText('****0001');

  await page.getByRole('switch', { name: '启用研发群 A' }).click();
  await expect(renamed.getByRole('button', { name: '测试' })).toBeDisabled();
});

test('邮件通道：必填项与收件人；修改时回填非敏感字段，密码留空', async ({ page, request }) => {
  await resetDatabase();
  await setupInstance(request);
  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme/settings/notifications');
  await page.getByRole('button', { name: '登记通道' }).click();
  await page.getByLabel('通道类型').click();
  await page.getByRole('option', { name: '邮件' }).click();
  await page.getByLabel('名称', { exact: true }).fill('周报邮件');
  await page.getByLabel('SMTP 服务器').fill('smtp.example.com');
  await page.getByLabel('用户名').fill('robot@example.com');
  await page.getByLabel('密码').fill('demo-pass');
  await page.getByLabel('发件人').fill('robot@example.com');
  await page.getByLabel('收件人').fill('pm@example.com, dev@example.com');
  await page.getByRole('button', { name: '保存' }).click();
  const row = page.getByRole('row', { name: /周报邮件/ });
  await expect(row).toContainText('smtp.example.com:465 · robot@example.com → 2 个收件人');
  await row.getByRole('button', { name: '修改' }).click();
  await expect(page.getByLabel('SMTP 服务器')).toHaveValue('smtp.example.com');
  await expect(page.getByLabel('密码')).toHaveValue('');
  await expect(page.getByText('demo-pass')).toHaveCount(0);
});

test('消息模板：预置模板只改内容；新建自定义模板，语法错误给出提示；删除', async ({ page, request }) => {
  await resetDatabase();
  await setupInstance(request);
  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme/settings/notifications?tab=templates');
  await expect(page.getByRole('row', { name: /默认 · 事件推送/ })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: '预置' })).toHaveCount(4);

  await page.getByRole('row', { name: /默认 · 事件推送/ }).getByRole('button', { name: '修改' }).click();
  await expect(page.getByLabel('模板名称')).toBeDisabled();
  await page.getByLabel('内容').fill('{{subject.key}} {{event.label}}');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText('模板已保存')).toBeVisible();

  await page.getByRole('button', { name: '新建模板' }).click();
  await page.getByLabel('模板名称').fill('简版');
  await page.getByLabel('内容').fill('{{#a}}');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByRole('alert')).toContainText('模板语法错误');
  await page.getByLabel('内容').fill('{{subject.key}} {{summary}}');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByRole('row', { name: /简版/ })).toBeVisible();
  await page.getByRole('row', { name: /简版/ }).getByRole('button', { name: '删除' }).click();
  await page.getByRole('button', { name: '确认删除' }).click();
  await expect(page.getByRole('row', { name: /默认 · 事件推送/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /简版/ })).toHaveCount(0);
});

test('通道与模板页签在 1440 与 760 宽度下不横向滚动', async ({ page, request }) => {
  await resetDatabase();
  await setupInstance(request);
  await login(page, OWNER.email, OWNER.password);
  await request.post('/api/v1/orgs/acme/notification-channels', {
    data: { kind: 'wecom_robot', name: '一个名字比较长的研发群机器人', groupLabel: '研发中心', config: { url: hook.url('layout-0001') } },
  });
  for (const width of [1440, 760]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/acme/settings/notifications');
    await expect(page.getByRole('row', { name: /一个名字比较长/ })).toBeVisible();
    await expectNoPageOverflow(page);
    await page.goto('/acme/settings/notifications?tab=templates');
    await expect(page.getByRole('row', { name: /默认 · 事件推送/ })).toBeVisible();
    await expectNoPageOverflow(page);
  }
});
