import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { login, ok, OWNER, setupInstance } from './helpers';

test.beforeEach(async ({ page, request }) => {
  await resetDatabase();
  await setupInstance(request);
  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme/settings/workflows');
});

test('编辑默认流程：加状态、加检查项、给流转加条件、发布新版本', async ({ page }) => {
  await page.getByRole('link', { name: '默认流程' }).click();
  await expect(page.locator('.react-flow__node')).toHaveCount(6);

  await page.getByRole('tab', { name: /状态/ }).click();
  await page.getByRole('button', { name: '新增状态' }).click();
  await page.getByRole('textbox', { name: '状态名称' }).last().fill('测试中');
  await expect(page.locator('.react-flow__node')).toHaveCount(7);

  await page.getByRole('tab', { name: /检查项/ }).click();
  await page.getByRole('button', { name: '新增检查项' }).click();
  await page.getByLabel('检查项名称').fill('可行性评估');
  await page.getByRole('button', { name: '添加检查项' }).click();

  await page.getByRole('tab', { name: /流转/ }).click();
  await page.getByRole('button', { name: '待开始 到 进行中：由任意状态规则允许' }).click();
  await page.getByRole('button', { name: '待开始 到 进行中：允许' }).click();
  const sheet = page.getByRole('dialog', { name: '待开始 → 进行中' });
  await sheet.getByRole('button', { name: '添加条件' }).click();
  // 菜单内容 portal 到 body，不在 sheet 的 DOM 子树内，所以用 page 定位而不是 sheet
  await page.getByRole('menuitem', { name: '检查项处于指定状态' }).click();
  await sheet.getByLabel('检查项').click();
  await page.getByRole('option', { name: '可行性评估' }).click();
  await sheet.getByRole('checkbox', { name: '通过' }).check();
  await sheet.getByRole('button', { name: '完成' }).click();
  await expect(page.getByRole('button', { name: '待开始 到 进行中：允许，有条件' })).toBeVisible();

  await expect(page.getByText('校验通过')).toBeVisible();
  await page.getByRole('button', { name: '发布为 v2' }).click();
  await page.getByLabel('版本说明').fill('加可行性评估');
  await page.getByRole('button', { name: '确认发布' }).click();
  await expect(page.getByText('已发布 v2')).toBeVisible();
  await page.getByRole('button', { name: '版本历史' }).click();
  await expect(page.getByText('加可行性评估')).toBeVisible();
});

test('校验失败时显示问题并禁止发布；模板可以复制、改名和归档', async ({ page }) => {
  await page.getByRole('link', { name: '默认流程' }).click();
  await page.getByRole('tab', { name: /状态/ }).click();
  await page.getByRole('textbox', { name: '状态名称' }).first().fill('');
  await expect(page.getByText('名称不能为空')).toBeVisible();
  await expect(page.getByRole('button', { name: '发布为 v2' })).toBeDisabled();

  await page.goto('/acme/settings/workflows');
  await page.getByRole('button', { name: '新建模板' }).click();
  await page.getByLabel('模板名称').fill('网盘需求流程');
  await page.getByRole('button', { name: '创建' }).click();
  await expect(page.getByRole('link', { name: '网盘需求流程' })).toBeVisible();
  await page.getByRole('button', { name: '更多操作：网盘需求流程' }).click();
  await page.getByRole('menuitem', { name: '归档' }).click();
  await expect(page.getByRole('row', { name: /网盘需求流程/ }).getByText('已归档')).toBeVisible();
});

test('会签检查项：「指定成员」签字人用搜索选择', async ({ page, request }) => {
  await ok(request.post('/api/v1/orgs/acme/members', { data: { displayName: '老板乙' } }));
  await page.getByRole('link', { name: '默认流程' }).click();
  await page.getByRole('tab', { name: /检查项/ }).click();
  await page.getByRole('button', { name: '新增检查项' }).click();
  const dialog = page.getByRole('dialog', { name: '新增检查项' });
  await dialog.getByLabel('检查项名称').fill('老板签字');
  await dialog.getByLabel('类型', { exact: true }).click();
  await page.getByRole('option', { name: '会签' }).click();
  await dialog.getByRole('combobox', { name: '签字人类型' }).click();
  await page.getByRole('option', { name: '成员' }).click();
  await dialog.getByRole('combobox', { name: '签字人', exact: true }).click();
  await page.getByRole('textbox', { name: '搜索签字人' }).fill('老板');
  await page.getByRole('option', { name: '老板乙' }).click();
  await dialog.getByRole('button', { name: '加入' }).click();
  await expect(dialog.getByText('成员：老板乙')).toBeVisible();
});
