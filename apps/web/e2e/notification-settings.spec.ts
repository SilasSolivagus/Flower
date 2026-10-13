import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { createProduct, createRequirement, createWecomChannel, expectNoPageOverflow, login, memberRequest, ok, setupInstance, tick } from './helpers';

test('个人设置：按类保存偏好并生效；企业微信列在未绑定时置灰并说明；扫码未开启时不可用；回调结果；解除绑定；760 不横向滚动', async ({ page, request }) => {
  await resetDatabase();
  await setupInstance(request);
  const productId = await createProduct(request);
  const zhang = await memberRequest(request, { email: 'zhang@example.com', name: '张三' });
  await login(page, 'zhang@example.com', 'password123');
  await page.goto('/settings');
  const section = page.getByRole('region', { name: '通知' });
  await expect(section.getByRole('switch', { name: '被指派 · 站内' })).toBeChecked();
  await expect(section.getByRole('switch', { name: '被指派 · 企业微信' })).toBeDisabled();
  await expect(section.getByText('企业微信：还没有绑定企业微信')).toBeVisible();
  await expect(section.getByText('邮件：组织还没有指定个人通知邮件通道')).toBeVisible();
  await expect(section.getByRole('switch', { name: '系统告警 · 站内' })).toHaveCount(0);
  await expect(section.getByRole('button', { name: '绑定企业微信' })).toBeDisabled();

  await section.getByRole('switch', { name: '被指派 · 站内' }).click();
  await expect(page.getByText('已保存')).toBeVisible();
  await expect(section.getByRole('switch', { name: '被指派 · 站内' })).not.toBeChecked();
  const req = await createRequirement(request, productId, '登录页改版');
  await ok(request.patch(`/api/v1/orgs/acme/requirements/${req.id}`, { data: { ownerMemberId: zhang.memberId } }));
  expect((await tick(request)).notified).toBe(0);

  // 组织管理员填写企业微信账号、产品指定个人提醒通道后，企业微信一列可以修改
  await ok(request.put(`/api/v1/orgs/acme/members/${zhang.memberId}/wecom`, { data: { userid: 'zhangsan' } }));
  const channelId = await createWecomChannel(request, '研发群', 'http://127.0.0.1:9/cgi-bin/webhook/send?key=settings-0001');
  await ok(request.put(`/api/v1/orgs/acme/products/${productId}/personal-channel`, { data: { channelId } }));
  await page.reload();
  await expect(section.getByRole('switch', { name: '被指派 · 企业微信' })).toBeEnabled();
  await expect(section.getByText('zhangsan')).toBeVisible();

  await page.goto(`/settings?org=acme&wecom_error=${encodeURIComponent('绑定链接已过期（10 分钟内有效），请重新扫码')}`);
  await expect(section.getByRole('alert')).toHaveText('企业微信绑定失败：绑定链接已过期（10 分钟内有效），请重新扫码');
  await page.goto('/settings?org=acme&wecom=bound');
  await expect(section.getByRole('status')).toHaveText('企业微信绑定成功。');

  await page.setViewportSize({ width: 760, height: 900 });
  await expect(section.getByRole('switch', { name: '被指派 · 站内' })).toBeVisible();
  await expectNoPageOverflow(page);

  await section.getByRole('button', { name: '解除绑定' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '解除绑定' }).click();
  await expect(section.getByText('企业微信账号：未绑定')).toBeVisible();
  await zhang.ctx.dispose();
});

test('个人设置：wecom_error 只作为文本显示，不解析为标签', async ({ page, request }) => {
  await resetDatabase();
  await setupInstance(request);
  await login(page, 'owner@example.com', 'password123');
  await page.goto(`/settings?org=acme&wecom_error=${encodeURIComponent('<b>x</b>')}`);
  const section = page.getByRole('region', { name: '通知' });
  await expect(section.getByRole('alert')).toHaveText('企业微信绑定失败：<b>x</b>');
  await expect(section.getByRole('alert').locator('b')).toHaveCount(0);
  await expect(page.locator('main b, section b')).toHaveCount(0);
});
