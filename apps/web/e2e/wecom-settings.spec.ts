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
test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

const placeholder = async (request: Parameters<typeof createProduct>[0], displayName: string, email: string) =>
  (await json<{ member: { id: string } }>(request.post('/api/v1/orgs/acme/members', { data: { displayName, email } }))).member.id;

test('成员页：企业微信账号列（修改、重复提示）与批量导入（预览、确认）；1440 与 760 不横向滚动', async ({ page, request }) => {
  await placeholder(request, '张三', 'zhang@example.com');
  await placeholder(request, '李四', 'li@example.com');
  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme/settings/members');
  await page.getByRole('button', { name: '修改张三的企业微信账号' }).click();
  const dialog = page.getByRole('dialog', { name: '张三的企业微信账号' });
  await dialog.getByLabel('企业微信账号').fill('zhangsan');
  await dialog.getByRole('button', { name: '保存' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('row', { name: /张三/ })).toContainText('zhangsan');

  await page.getByRole('button', { name: '修改李四的企业微信账号' }).click();
  const dup = page.getByRole('dialog', { name: '李四的企业微信账号' });
  await dup.getByLabel('企业微信账号').fill('zhangsan');
  await dup.getByRole('button', { name: '保存' }).click();
  await expect(dup.getByRole('alert')).toHaveText('该企业微信账号已绑定到 张三');
  await dup.getByRole('button', { name: '取消' }).click();

  await page.getByRole('button', { name: '导入企业微信账号' }).click();
  const imp = page.getByRole('dialog', { name: '导入企业微信账号' });
  await imp.getByLabel('CSV 文件').setInputFiles({
    name: 'wecom.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('﻿邮箱,企业微信账号\r\nli@example.com,lisi\r\nnobody@example.com,x\r\nzhang@example.com,zhangsan\r\n'),
  });
  await expect(imp.getByText('wecom.csv：可匹配 1、无变化 1、找不到成员 1、账号重复 0、格式不对 0')).toBeVisible();
  await expect(imp.getByRole('table', { name: '导入预览' })).toContainText('找不到该邮箱的在职成员');
  await expect(imp.getByRole('table', { name: '导入预览' })).toBeVisible();
  const lisi = (await json<{ members: { displayName: string; wecomUserid: string | null }[] }>(page.request.get('/api/v1/orgs/acme/members'))).members.find((m) => m.displayName === '李四');
  expect(lisi?.wecomUserid ?? null).toBeNull();
  await imp.getByRole('button', { name: '确认导入' }).click();
  await expect(page.getByText('已写入 1 个成员的企业微信账号')).toBeVisible();
  await expect(page.getByRole('row', { name: /李四/ })).toContainText('lisi');
  await expectNoPageOverflow(page);
  await page.setViewportSize({ width: 760, height: 900 });
  await expectNoPageOverflow(page);
});

test('推送页：企业微信应用（密钥只显示提示、回调地址）与个人通知邮件通道；产品设置的个人提醒通道生效', async ({ page, request }) => {
  const productId = await createProduct(request);
  const channelId = await createWecomChannel(request, '研发群', hook.url('personal-0001'));
  const mailId = (
    await json<{ channel: { id: string } }>(
      request.post('/api/v1/orgs/acme/notification-channels', {
        data: { kind: 'email', name: '通知邮件', config: { host: 'smtp.example.com', port: 465, secure: true, user: 'robot@example.com', pass: 'demo-pass', from: 'robot@example.com', to: ['pm@example.com'] } },
      }),
    )
  ).channel.id;
  const otherProductId = await createProduct(request, '其他产品', 'OTH');
  await createWecomChannel(request, '停用群', hook.url('off-0001'), { enabled: false });
  await createWecomChannel(request, '他产品群', hook.url('other-0001'), { allowedProductIds: [otherProductId] });
  await ok(
    request.post('/api/v1/orgs/acme/notification-channels', {
      data: { kind: 'email', name: '停用邮件', enabled: false, config: { host: 'smtp.example.com', port: 465, secure: true, user: 'robot@example.com', pass: 'demo-pass', from: 'robot@example.com', to: ['pm@example.com'] } },
    }),
  );
  await login(page, OWNER.email, OWNER.password);

  await page.goto('/acme/settings/notifications?tab=wecom');
  await page.getByLabel('企业 ID').fill('ww0001');
  await page.getByLabel('应用 ID（AgentId）').fill('1000002');
  await page.getByLabel('应用密钥').fill('app-secret-demo-0001');
  await page.getByRole('switch', { name: '允许成员扫码绑定' }).click();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText('已保存')).toBeVisible();
  await expect(page.getByLabel('应用密钥')).toHaveValue('');
  await expect(page.getByLabel('应用密钥')).toHaveAttribute('placeholder', '已设置 ****0001，留空表示不变');
  await expect(page.getByLabel('回调地址')).toHaveValue('http://localhost:3100/api/v1/orgs/acme/wecom/callback');
  await expect(page.getByLabel('授权回调域（填到自建应用的网页授权设置里）')).toHaveValue('localhost:3100');
  expect(await page.content()).not.toContain('app-secret-demo-0001');
  await expectNoPageOverflow(page);
  await page.setViewportSize({ width: 760, height: 900 });
  await expectNoPageOverflow(page);
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.goto('/acme/settings/notifications');
  await page.getByLabel('个人通知邮件通道').click();
  await expect(page.getByRole('option', { name: '通知邮件' })).toBeVisible();
  expect(await page.getByRole('option').allTextContents()).toEqual(['不发邮件', '通知邮件']);
  await page.getByRole('option', { name: '通知邮件' }).click();
  await expect.poll(async () => (await json<{ channelId: string | null }>(request.get('/api/v1/orgs/acme/personal-email-channel'))).channelId).toBe(mailId);

  await page.goto(`/acme/settings/products/${productId}`);
  await page.getByRole('tab', { name: '推送' }).click();
  await page.getByLabel('个人提醒通道').click();
  await expect(page.getByRole('option', { name: '研发群' })).toBeVisible();
  expect(await page.getByRole('option').allTextContents()).toEqual(['不发企业微信个人提醒', '研发群']);
  await page.getByRole('option', { name: '研发群' }).click();
  await expect.poll(async () => (await json<{ channelId: string | null }>(request.get(`/api/v1/orgs/acme/products/${productId}/personal-channel`))).channelId).toBe(channelId);

  const zhangId = await placeholder(request, '张三', 'zhang@example.com');
  await ok(request.put(`/api/v1/orgs/acme/members/${zhangId}/wecom`, { data: { userid: 'zhangsan' } }));
  const req = await createRequirement(request, productId, '登录页改版');
  await ok(request.patch(`/api/v1/orgs/acme/requirements/${req.id}`, { data: { ownerMemberId: zhangId } }));
  const before = hook.received.length;
  expect((await tick(request)).sent).toBe(1);
  expect(hook.received.length).toBe(before + 1);
  expect((hook.received.at(-1)!.body as { markdown: { content: string } }).markdown.content).toBe(
    '<@zhangsan> 林澄 把你设为需求负责人：[PAN-1 登录页改版](http://localhost:3100/acme/requirements/PAN-1)',
  );
});
