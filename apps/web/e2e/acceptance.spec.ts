import { expect, test } from '@playwright/test';
import { resetDatabase } from './db';
import { OWNER } from './helpers';

test('P0 验收：从初始化到签发 Agent Token 的完整路线', async ({ page, browser, playwright }) => {
  test.setTimeout(180_000);
  await resetDatabase();

  // 1. 初始化向导
  await page.goto('/');
  await page.waitForURL('**/setup');
  await page.getByLabel('你的姓名').fill(OWNER.name);
  await page.getByLabel('邮箱').fill(OWNER.email);
  await page.getByLabel('密码', { exact: true }).fill(OWNER.password);
  await page.getByLabel('确认密码').fill(OWNER.password);
  await page.getByRole('button', { name: '下一步' }).click();
  await page.getByLabel('组织名称').fill('123云盘');
  await page.getByLabel('组织标识').fill('pan');
  await page.getByRole('button', { name: '完成初始化' }).click();
  await page.getByRole('link', { name: '进入组织' }).click();
  await page.waitForURL('**/pan');
  await expect(page.getByRole('heading', { name: '工作台', level: 1 })).toBeVisible();
  await page.goto('/pan/overview');
  await expect(page.getByText('已完成 0 / 6')).toBeVisible();

  // 2. 邀请成员 + 登记无账号成员
  await page.goto('/pan/settings/members');
  await page.getByRole('button', { name: '邀请成员' }).click();
  await page.getByLabel('邮箱').fill('pm@example.com');
  await page.getByRole('button', { name: '发送邀请' }).click();
  const link = await page.getByLabel('邀请链接').inputValue();
  await page.getByRole('button', { name: '完成' }).click();
  await page.getByRole('button', { name: '登记无账号成员' }).click();
  await page.getByLabel('显示名称').fill('王总');
  await page.getByRole('button', { name: '登记' }).click();

  // 3. 职能标签分配
  await page.getByRole('button', { name: '查看林澄' }).click();
  await page.getByRole('dialog', { name: '林澄' }).getByRole('checkbox', { name: '产品经理' }).check();
  await page.getByRole('dialog', { name: '林澄' }).getByRole('button', { name: '保存' }).click();

  // 4. 建产品
  await page.goto('/pan/settings/products');
  await page.getByRole('button', { name: '新建产品' }).click();
  await page.getByLabel('产品名称').fill('网盘');
  await page.getByLabel('编号前缀').fill('PAN');
  await page.getByRole('button', { name: '创建' }).click();
  await page.waitForURL('**/settings/products/*');

  // 5. 编辑流程并发布
  await page.goto('/pan/settings/workflows');
  await page.getByRole('link', { name: '默认流程' }).click();
  await page.getByRole('tab', { name: /检查项/ }).click();
  await page.getByRole('button', { name: '新增检查项' }).click();
  await page.getByLabel('检查项名称').fill('PRD 评审');
  await page.getByRole('button', { name: '添加检查项' }).click();
  await page.getByRole('button', { name: '发布为 v2' }).click();
  await page.getByLabel('版本说明').fill('增加 PRD 评审');
  await page.getByRole('button', { name: '确认发布' }).click();
  await expect(page.getByText('已发布 v2')).toBeVisible();

  // 6. 字典
  await page.goto('/pan/settings/fields');
  const platform = page.getByRole('region', { name: '平台' });
  await platform.getByLabel('新选项').fill('PC客户端');
  await platform.getByRole('button', { name: '添加' }).click();
  await expect(platform.getByRole('textbox', { name: '选项名称' })).toHaveCount(1);

  // 7. Agent 与只读 Token
  await page.goto('/pan/settings/agents');
  await page.getByRole('button', { name: '创建 Agent' }).click();
  await page.getByLabel('Agent 名称').fill('PRD 助手');
  await page.getByRole('button', { name: '创建' }).click();
  await page.getByRole('button', { name: '签发 Token' }).click();
  await page.getByLabel('Token 名称').fill('Claude Code');
  await page.getByRole('radio', { name: '只读' }).click();
  await page.getByRole('button', { name: '签发' }).click();
  const token = await page.getByLabel('Token（只显示一次）').inputValue();
  await page.getByRole('button', { name: '我已保存' }).click();

  // 8. 配置清单全部完成
  await page.goto('/pan/overview');
  await expect(page.getByText('已完成 6 / 6')).toBeVisible();

  // 9. 受邀成员加入后看不到设置入口
  const ctx = await browser.newContext();
  const pm = await ctx.newPage();
  await pm.goto(link.replace(/^https?:\/\/[^/]+/, ''));
  await pm.getByLabel('你的姓名').fill('周屿');
  await pm.getByLabel('设置密码').fill('password123');
  await pm.getByRole('button', { name: '接受邀请' }).click();
  await pm.waitForURL('**/pan');
  await expect(pm.getByText('组织设置')).toHaveCount(0);
  await ctx.close();

  // 10. Token 只读
  const api = await playwright.request.newContext({ baseURL: 'http://localhost:3100', extraHTTPHeaders: { authorization: `Bearer ${token}` } });
  expect((await api.get('/api/v1/orgs/pan/products')).status()).toBe(200);
  expect((await api.post('/api/v1/orgs/pan/products', { data: { name: 'x', key: 'XX' } })).status()).toBe(403);
  await api.dispose();
});
