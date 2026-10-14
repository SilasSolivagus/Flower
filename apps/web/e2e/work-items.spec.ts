import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { createProduct, createRequirement, expectNoPageOverflow, json, login, memberRequest, ok, OWNER, setupInstance, tick } from './helpers';

test.beforeEach(async () => {
  await resetDatabase();
});

test('工作项全流程：新建、负责人、描述与 @、暂停与恢复、进展记录、阻塞项、关注、状态切换、删除；1440 与 760 不横向滚动', async ({ page, request }) => {
  await setupInstance(request);
  await createProduct(request);
  const zhang = await memberRequest(request, { email: 'zhang@example.com', name: '张三' });
  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme/tracking');
  await page.getByRole('button', { name: '新建工作项' }).click();
  const create = page.getByRole('dialog', { name: '新建工作项' });
  await create.getByLabel('标题').fill('协助客服排查上传失败');
  await create.getByLabel('工作类型').click();
  await page.getByRole('option', { name: '技术支持' }).click();
  await create.getByLabel('启动日期').fill('2026-10-08');
  await create.getByLabel('预计完成日期').fill('2026-10-20');
  await create.getByRole('button', { name: '创建' }).click();
  await expect(page.getByText('已创建 W-1')).toBeVisible();
  const table = page.getByRole('table', { name: '全部在手' });
  await expect(table.getByRole('row', { name: /协助客服排查上传失败/ })).toContainText('技术支持');
  await table.getByRole('link', { name: '协助客服排查上传失败' }).click();
  await page.waitForURL('**/acme/work-items/W-1');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('协助客服排查上传失败');
  await expect(page.locator('nav[aria-label="主导航"] a[href="/acme/tracking"]')).toHaveAttribute('aria-current', 'page');
  await expectNoPageOverflow(page);

  const info = page.getByRole('region', { name: '基本信息' });
  await expect(info.getByLabel('工作类型')).toHaveText('技术支持');
  await expect(info.getByLabel('启动日期')).toHaveValue('2026-10-08');
  await info.getByRole('combobox', { name: '负责人' }).click();
  await page.getByRole('option', { name: '张三' }).click();
  await expect(info.getByRole('combobox', { name: '负责人' })).toHaveText('张三');

  const desc = page.getByRole('region', { name: '描述' });
  await desc.getByRole('button', { name: '编辑' }).click();
  await desc.getByLabel('描述').click();
  await page.keyboard.type('请 @张');
  await page.getByRole('listbox', { name: '成员补全' }).getByRole('option', { name: /张三/ }).click();
  await page.keyboard.type(' 见 [[PAN-1]]');
  await desc.getByRole('button', { name: '保存' }).click();
  await expect(desc.getByText('@张三', { exact: true })).toBeVisible();
  await expect(desc).toContainText('[[PAN-1]]');
  await expect(desc.getByRole('link')).toHaveCount(0);

  await info.getByRole('button', { name: '暂停', exact: true }).click();
  const pause = page.getByRole('dialog', { name: '暂停', exact: true });
  await pause.getByLabel('暂停原因').fill('等对方排期');
  await pause.getByRole('button', { name: '确认暂停' }).click();
  await expect(info).toContainText('已暂停：等对方排期');
  await info.getByRole('button', { name: '恢复' }).click();
  await expect(info).not.toContainText('已暂停');

  const progress = page.getByRole('region', { name: /^进展记录/ });
  await progress.getByRole('button', { name: '写进展' }).click();
  const dialog = page.getByRole('dialog', { name: '写进展' });
  await expect(dialog.getByLabel('预计完成日期')).toHaveValue('2026-10-20');
  await dialog.getByLabel('进展').fill('已定位到网关超时');
  await dialog.getByRole('combobox', { name: '跟进人' }).click();
  await page.getByRole('option', { name: '张三' }).click();
  await dialog.getByRole('button', { name: '保存' }).click();
  await expect(progress.getByRole('list', { name: '进展记录列表' })).toContainText('已定位到网关超时');

  const blockers = page.getByRole('region', { name: '阻塞项' });
  await blockers.getByLabel('新阻塞项').fill('等网关团队回复');
  await blockers.getByRole('button', { name: '添加' }).click();
  await expect(blockers).toContainText('等网关团队回复');
  await blockers.getByRole('button', { name: '解除：等网关团队回复' }).click();
  await expect(blockers).toContainText('已解除 1 条');

  await page.getByRole('button', { name: '关注', exact: true }).click();
  await expect(page.getByRole('button', { name: '已关注' })).toBeVisible();

  expect((await tick(request)).notified).toBeGreaterThanOrEqual(3);
  const inbox = await json<{ notifications: Array<{ kind: string; body: string; url: string }> }>(zhang.ctx.get('/api/v1/orgs/acme/notifications'));
  expect(inbox.notifications.map((n) => [n.kind, n.body, n.url])).toEqual(
    expect.arrayContaining([
      ['assigned', '把工作项指派给你', '/acme/work-items/W-1'],
      ['mentioned', '在工作项描述中 @ 了你', '/acme/work-items/W-1'],
      ['assigned', '你是下一步跟进人', '/acme/work-items/W-1'],
    ]),
  );

  await info.getByLabel('状态').click();
  await page.getByRole('option', { name: '已完成' }).click();
  await expect(info.getByLabel('状态')).toHaveText('已完成');
  await expect(info.getByRole('button', { name: '暂停', exact: true })).toHaveCount(0);

  await page.setViewportSize({ width: 760, height: 900 });
  await expect(info).toBeVisible();
  await expectNoPageOverflow(page);

  await info.getByRole('button', { name: '删除工作项' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '删除' }).click();
  await page.waitForURL('**/acme/tracking');
  await expect(page.getByText('还没有在手的工作')).toBeVisible();
  await zhang.ctx.dispose();
});

test('工作台：「我负责的需求与工作项」列出进行中的工作项；「等我跟进」列出我是跟进人的条目，点击进入详情；1440 与 760', async ({ page, request }) => {
  await setupInstance(request);
  const productId = await createProduct(request);
  const zhang = await memberRequest(request, { email: 'zhang@example.com', name: '张三' });
  const me = (await json<{ me: { memberId: string } }>(request.get('/api/v1/orgs/acme'))).me.memberId;
  await ok(request.post('/api/v1/orgs/acme/work-items', { data: { title: '我负责的工作项', ownerMemberId: me } }));
  const req = await createRequirement(request, productId, '等我确认的需求');
  await ok(request.post(`/api/v1/orgs/acme/requirements/${req.id}/transitions`, { data: { to: 'doing' } }));
  await ok(zhang.ctx.post(`/api/v1/orgs/acme/requirements/${req.id}/progress`, { data: { body: '方案初稿', nextStep: '请确认方案', followerMemberId: me } }));
  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme');
  const owned = page.getByRole('region', { name: /我负责的需求与工作项/ });
  await expect(owned.getByRole('link', { name: /我负责的工作项/ })).toBeVisible();
  const following = page.getByRole('region', { name: /等我跟进/ });
  await expect(following.getByRole('link', { name: /等我确认的需求/ })).toContainText('请确认方案');
  await expectNoPageOverflow(page);
  await following.getByRole('link', { name: /等我确认的需求/ }).click();
  await page.waitForURL(`**/acme/requirements/${req.displayKey}`);
  await page.goto('/acme');
  await owned.getByRole('link', { name: /我负责的工作项/ }).click();
  await page.waitForURL('**/acme/work-items/W-1');
  await page.setViewportSize({ width: 760, height: 900 });
  await page.goto('/acme');
  await expect(following.getByRole('link', { name: /等我确认的需求/ })).toBeVisible();
  await expectNoPageOverflow(page);
  await zhang.ctx.dispose();
});
