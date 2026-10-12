import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { createProduct, createRequirement, json, login, ok, OWNER, setupInstance } from './helpers';

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
