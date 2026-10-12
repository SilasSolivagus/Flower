import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { createDocument, createProduct, createRequirement, json, login, memberRequest, ok, OWNER, presetTemplateId, setupInstance, tick } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

test('评论与需求描述：输入 @ 补全成员，看不到产品的标出来，回车插入，Esc 关闭；显示为成员标签并按当前姓名显示；已离开成员的 @ 显示为灰色原名', async ({ page, request }) => {
  const productId = await createProduct(request);
  const req = await createRequirement(request, productId, '登录页改版');
  const zhangId = (await json<{ member: { id: string } }>(request.post('/api/v1/orgs/acme/members', { data: { displayName: '张三', email: 'zhang@example.com' } }))).member.id;
  const guestId = (await json<{ member: { id: string } }>(request.post('/api/v1/orgs/acme/members', { data: { displayName: '张访客', email: 'guest@example.com' } }))).member.id;
  await ok(request.patch(`/api/v1/orgs/acme/members/${guestId}`, { data: { orgRole: 'guest' } }));
  await ok(request.put(`/api/v1/orgs/acme/members/${zhangId}/wecom`, { data: { userid: 'zhangsan' } }));
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/requirements/${req.displayKey}`);

  const comments = page.getByRole('region', { name: /^评论/ });
  const input = comments.getByRole('textbox', { name: '写评论' });
  await input.click();
  await page.keyboard.type('请 @张访');
  const list = page.getByRole('listbox', { name: '成员补全' });
  await expect(list.getByRole('option', { name: /张访客.*看不到这个产品/ })).toBeVisible();
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('张三');
  await expect(list.getByRole('option')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(input).toHaveValue(`请 [@张三](member:${zhangId}) `);
  await expect(list).toBeHidden();
  await page.keyboard.type('邮箱 a@b.com 看一下');
  await expect(list).toBeHidden();
  await comments.getByRole('button', { name: '发表' }).click();
  const chip = comments.getByText('@张三', { exact: true });
  await expect(chip).toBeVisible();
  await expect(chip).toHaveAttribute('title', 'zhang@example.com · 已绑定企业微信');

  const desc = page.getByRole('region', { name: '描述' });
  await desc.getByRole('button', { name: '编辑' }).click();
  const box = desc.getByRole('textbox', { name: '描述' });
  await box.click();
  await page.keyboard.type('负责人 @zhang');
  await expect(list.getByRole('option', { name: /张三/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(list).toBeHidden();
  await box.fill(`负责人 [@张三](member:${zhangId})`);
  await desc.getByRole('button', { name: '保存' }).click();
  await expect(desc.getByText('@张三', { exact: true })).toBeVisible();

  // 改名后按当前姓名显示；离开组织后显示为灰色并在说明里注明
  await ok(request.patch(`/api/v1/orgs/acme/members/${zhangId}`, { data: { displayName: '张三丰' } }));
  await page.reload();
  await expect(comments.getByText('@张三丰', { exact: true })).toBeVisible();
  await ok(request.patch(`/api/v1/orgs/acme/members/${zhangId}`, { data: { status: 'left' } }));
  await page.reload();
  // 已离开成员的 @ 显示为灰色原名（写入时的姓名），不跟随改名
  const left = comments.getByText('@张三', { exact: true });
  await expect(left).toHaveAttribute('title', 'zhang@example.com · 已绑定企业微信 · 已离开组织');
  await expect(left).toHaveClass(/text-muted-foreground/);
});

test('PRD 正文：输入 @ 补全成员并插入成员标签；自动保存后正文为 @ 写法，刷新后仍显示；被 @ 的人收到通知', async ({ page, request }) => {
  const productId = await createProduct(request);
  const zhang = await memberRequest(request, { email: 'zhang@example.com', name: '张三' });
  const doc = await createDocument(request, productId, { title: '登录 PRD', templateId: await presetTemplateId(request, productId) });
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/documents/${doc.displayKey}`);
  const body = page.getByRole('region', { name: '正文' });
  await expect(body).toContainText('1. 背景介绍');
  await body.locator('.bn-block-content').last().click();
  await page.keyboard.press('End');
  await page.keyboard.type('请 @张');
  await expect(page.getByRole('option', { name: /张三/ })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(body.locator('.mention-chip')).toHaveText('@张三');
  await expect(body.getByRole('status')).toHaveText('已保存');
  const saved = await json<{ document: { markdown: string } }>(request.get(`/api/v1/orgs/acme/documents/${doc.displayKey}`));
  expect(saved.document.markdown).toContain(`[@张三](member:${zhang.memberId})`);
  await page.reload();
  await expect(page.getByRole('region', { name: '正文' }).locator('.mention-chip')).toHaveText('@张三');
  expect((await tick(request)).notified).toBe(1);
  const list = await json<{ notifications: Array<{ body: string; title: string }> }>(zhang.ctx.get('/api/v1/orgs/acme/notifications'));
  expect(list.notifications.map((n) => [n.body, n.title])).toEqual([['在 PRD 正文中 @ 了你', 'PAN-PRD-1 登录 PRD']]);
  await zhang.ctx.dispose();
});

test('PRD 正文：@ 没有匹配的成员时回车关闭补全并照常换行；已离开成员的 @ 显示为灰色原名', async ({ page, request }) => {
  const productId = await createProduct(request);
  const zhangId = (await json<{ member: { id: string } }>(request.post('/api/v1/orgs/acme/members', { data: { displayName: '张三', email: 'zhang@example.com' } }))).member.id;
  const doc = await createDocument(request, productId, { title: '登录 PRD' });
  await ok(request.put(`/api/v1/orgs/acme/documents/${doc.id}/content`, { data: { baseVersion: doc.version, markdown: `负责人 [@张三](member:${zhangId})` } }));
  await ok(request.patch(`/api/v1/orgs/acme/members/${zhangId}`, { data: { displayName: '张三丰' } }));
  await ok(request.patch(`/api/v1/orgs/acme/members/${zhangId}`, { data: { status: 'left' } }));
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/documents/${doc.displayKey}`);
  const body = page.getByRole('region', { name: '正文' });
  const chip = body.locator('.mention-chip');
  await expect(chip).toHaveText('@张三');
  await expect(chip).toHaveClass(/mention-chip-grey/);
  await expect(chip).toHaveAttribute('title', /已离开组织/);

  await body.locator('.bn-block-content').last().click();
  await page.keyboard.press('End');
  await page.keyboard.type(' @无此人');
  const empty = page.getByText('无匹配项');
  await expect(empty).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(empty).toBeHidden();
  await page.keyboard.type('下一行');
  await expect(body.locator('.bn-block-content')).toHaveCount(2);
  await expect(body.locator('.bn-block-content').first()).toContainText('@无此人');
  await expect(body.locator('.bn-block-content').last()).toHaveText('下一行');
  // 读入的 @ 再次保存时写法不变（仍是写入时的姓名）
  await expect(body.getByRole('status')).toHaveText('已保存');
  const saved = await json<{ document: { markdown: string } }>(request.get(`/api/v1/orgs/acme/documents/${doc.displayKey}`));
  expect(saved.document.markdown).toContain(`负责人 [@张三](member:${zhangId}) @无此人`);
});
