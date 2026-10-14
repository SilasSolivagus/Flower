import { type APIRequestContext, expect, test } from '@playwright/test';
import { adminSql, resetDatabase } from './db';
import { acceptInvite, createProduct, createRequirement, expectNoPageOverflow, json, login, memberRequest, ok, OWNER, setupInstance, tick } from './helpers';

test.beforeEach(async () => {
  await resetDatabase();
});

const move = (request: APIRequestContext, id: string, to: string) => ok(request.post(`/api/v1/orgs/acme/requirements/${id}/transitions`, { data: { to } }));

type Seeded = {
  productId: string;
  zhang: { ctx: APIRequestContext; memberId: string };
  reqs: Record<'doing' | 'todo' | 'backlog', { id: string; displayKey: string }>;
};

/**
 * 网盘产品：「开发中的需求」（张三负责，进行中，停留 20 天、20 天没有进展）、「待开始的需求」（已暂停）、
 * 「收集中的需求」（待处理，手动加入跟进）；一个不关联产品的工作项「协助客服排查」（林澄负责）。
 */
async function seed(request: APIRequestContext): Promise<Seeded> {
  await setupInstance(request);
  const productId = await createProduct(request);
  const zhang = await memberRequest(request, { email: 'zhang@example.com', name: '张三' });
  const doing = await createRequirement(request, productId, '开发中的需求');
  await ok(request.patch(`/api/v1/orgs/acme/requirements/${doing.id}`, { data: { ownerMemberId: zhang.memberId } }));
  await move(request, doing.id, 'doing');
  await adminSql(`update requirements set state_changed_at = now() - interval '20 days', tracked_since = now() - interval '20 days' where id = $1`, [doing.id]);
  const todo = await createRequirement(request, productId, '待开始的需求');
  await move(request, todo.id, 'todo');
  await ok(request.post(`/api/v1/orgs/acme/requirements/${todo.id}/pause`, { data: { reason: '等法务确认' } }));
  const backlog = await createRequirement(request, productId, '收集中的需求');
  await ok(request.put(`/api/v1/orgs/acme/requirements/${backlog.id}/tracking`, { data: { tracking: true } }));
  const me = (await json<{ me: { memberId: string } }>(request.get('/api/v1/orgs/acme'))).me.memberId;
  await ok(request.post('/api/v1/orgs/acme/work-items', { data: { title: '协助客服排查', ownerMemberId: me } }));
  return { productId, zhang, reqs: { doing, todo, backlog } };
}

test('四个页签与筛选：全部在手、任务老化、按阶段看板、按产品经理；筛选与页签写入地址栏；1440 与 760 不横向滚动', async ({ page, request }) => {
  const { productId, zhang } = await seed(request);
  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme');
  await page.locator('nav[aria-label="主导航"] a[href="/acme/tracking"]').click();
  await page.waitForURL('**/acme/tracking');
  const table = page.getByRole('table', { name: '全部在手' });
  for (const title of ['开发中的需求', '待开始的需求', '收集中的需求', '协助客服排查']) await expect(table.getByRole('link', { name: title })).toBeVisible();
  const doingRow = table.getByRole('row', { name: /开发中的需求/ });
  await expect(doingRow).toContainText('张三');
  await expect(doingRow.locator('span', { hasText: /^20 天$/ })).toHaveClass(/bg-amber-100/);
  await expect(table.getByRole('row', { name: /待开始的需求/ }).getByText('已暂停')).toBeVisible();
  await expectNoPageOverflow(page);

  await page.getByRole('checkbox', { name: '只看暂停' }).click();
  await expect(page).toHaveURL(/paused=1/);
  await expect(table.getByRole('link', { name: '待开始的需求' })).toBeVisible();
  await expect(table.getByRole('link', { name: '开发中的需求' })).toHaveCount(0);
  await page.getByRole('button', { name: '清除筛选' }).click();
  await expect(page).toHaveURL(/\/acme\/tracking$/);

  await page.getByLabel('负责人', { exact: true }).click();
  await page.getByRole('option', { name: '张三' }).click();
  await expect(page).toHaveURL(new RegExp(`owner=${zhang.memberId}`));
  await expect(table.getByRole('link', { name: '开发中的需求' })).toBeVisible();
  await expect(table.getByRole('link', { name: '协助客服排查' })).toHaveCount(0);
  await page.getByRole('button', { name: '清除筛选' }).click();
  await expect(table.getByRole('link', { name: '协助客服排查' })).toBeVisible();

  await page.getByRole('tab', { name: '任务老化' }).click();
  await expect(page).toHaveURL(/tab=aging/);
  await expect(page.getByRole('region', { name: '按本阶段停留排序' }).getByRole('row').nth(1)).toContainText('开发中的需求');
  await expect(page.getByRole('region', { name: '超过 7 天没有进展记录' }).getByRole('link', { name: '开发中的需求' })).toBeVisible();

  await page.getByRole('tab', { name: '按阶段看板' }).click();
  await expect(page).toHaveURL(/tab=board/);
  for (const [column, title] of [
    ['收集', '收集中的需求'],
    ['未开始', '待开始的需求'],
    ['进行中', '开发中的需求'],
    ['工作项', '协助客服排查'],
  ]) {
    await expect(page.getByRole('region', { name: column, exact: true }).getByRole('article', { name: new RegExp(title) })).toBeVisible();
  }
  await page.getByLabel('产品', { exact: true }).click();
  await page.getByRole('option', { name: '网盘' }).click();
  await expect(page).toHaveURL(new RegExp(`product=${productId}`));
  await expect(page.getByRole('region', { name: '待处理', exact: true }).getByRole('article', { name: /收集中的需求/ })).toBeVisible();
  await expect(page.getByRole('region', { name: '待开始', exact: true }).getByRole('article', { name: /待开始的需求/ })).toBeVisible();

  await page.getByRole('tab', { name: '按产品经理' }).click();
  await expect(page).toHaveURL(/tab=owners/);
  await expect(page.getByRole('region', { name: '张三', exact: true })).toContainText('1 条 · 暂停 0 · 阻塞 0 · 老化 1');
  await expect(page.getByRole('region', { name: '未指定负责人', exact: true })).toContainText('2 条 · 暂停 1');

  await page.setViewportSize({ width: 760, height: 900 });
  for (const tab of ['all', 'aging', 'board', 'owners']) {
    await page.goto(`/acme/tracking?tab=${tab}`);
    await expect(page.getByRole('tab', { selected: true })).toBeVisible();
    await expect(page.getByText('协助客服排查').first()).toBeVisible();
    await expectNoPageOverflow(page);
  }
  await zhang.ctx.dispose();
});

test('写进展：小窗填写进展、下一步、跟进人，顺手改预计上线日期；连续填写保留上一次的跟进人；跟进人收到通知', async ({ page, request }) => {
  const { zhang, reqs } = await seed(request);
  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme/tracking');
  const table = page.getByRole('table', { name: '全部在手' });
  await table.getByRole('button', { name: `写进展：${reqs.doing.displayKey}` }).click();
  const dialog = page.getByRole('dialog', { name: '写进展' });
  await dialog.getByLabel('进展').fill('接口联调完成');
  await dialog.getByLabel('下一步').fill('约测试');
  await dialog.getByRole('combobox', { name: '跟进人' }).click();
  await page.getByRole('option', { name: '张三' }).click();
  await dialog.getByLabel('预计上线日期').fill('2026-11-30');
  await dialog.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText('已记录进展')).toBeVisible();
  const row = table.getByRole('row', { name: /开发中的需求/ });
  await expect(row).toContainText('接口联调完成 · 下一步：约测试 · 张三');
  await expect(row).toContainText('2026-11-30');

  await table.getByRole('button', { name: `写进展：${reqs.todo.displayKey}` }).click();
  await expect(dialog.getByRole('combobox', { name: '跟进人' })).toHaveText('张三');
  await dialog.getByLabel('进展').fill('法务已回复');
  await dialog.getByRole('button', { name: '保存' }).click();
  await expect(dialog).toBeHidden();
  await expect(table.getByRole('row', { name: /待开始的需求/ })).toContainText('法务已回复 · 张三');

  expect((await tick(request)).notified).toBeGreaterThanOrEqual(2);
  const inbox = await json<{ notifications: Array<{ kind: string; body: string }> }>(zhang.ctx.get('/api/v1/orgs/acme/notifications'));
  expect(inbox.notifications.map((n) => [n.kind, n.body])).toEqual(
    expect.arrayContaining([
      ['assigned', '你是下一步跟进人：约测试'],
      ['assigned', '你是下一步跟进人'],
    ]),
  );
  await zhang.ctx.dispose();
});

test('过期筛选：不认识的页签当作全部在手；产品不存在、负责人不在列表时显示「没有符合条件的条目」与「清除筛选」；格式错误显示「筛选参数无效」', async ({ page, request }) => {
  const { zhang } = await seed(request);
  await login(page, OWNER.email, OWNER.password);
  const random = '00000000-0000-4000-8000-000000000001';
  await page.goto(`/acme/tracking?tab=nope&product=${random}`);
  await expect(page.getByRole('tab', { name: '全部在手' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('没有符合条件的条目')).toBeVisible();
  await expect(page.getByLabel('产品', { exact: true })).toHaveText('（看不到的产品）');
  await page.getByRole('button', { name: '清除筛选' }).first().click();
  await expect(page).toHaveURL(/\/acme\/tracking$/);
  await expect(page.getByRole('table', { name: '全部在手' }).getByRole('link', { name: '开发中的需求' })).toBeVisible();

  await page.goto(`/acme/tracking?owner=${random}&tab=owners`);
  await expect(page.getByText('没有符合条件的条目')).toBeVisible();
  await expect(page.getByLabel('负责人', { exact: true })).toHaveText('（已不在列表中的负责人）');

  await page.goto('/acme/tracking?product=abc');
  await expect(page.getByText('筛选参数无效')).toBeVisible();
  await page.getByRole('button', { name: '清除筛选' }).click();
  await expect(page.getByRole('table', { name: '全部在手' })).toBeVisible();
  await zhang.ctx.dispose();
});

test('需求详情：跟进区块加入与移出、预计上线日期、暂停与恢复；进展记录页签新增、修改、删除', async ({ page, request }) => {
  await setupInstance(request);
  const productId = await createProduct(request);
  const req = await createRequirement(request, productId, '登录页改版');
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`/acme/requirements/${req.displayKey}`);
  const panel = page.getByRole('region', { name: '跟进', exact: true });
  await expect(panel).toContainText('未加入跟进');
  await panel.getByRole('button', { name: '加入跟进' }).click();
  await expect(panel).toContainText('跟进中');
  await panel.getByLabel('预计上线日期').fill('2026-11-30');
  await panel.getByLabel('预计上线日期').blur();
  await expect(page.getByText('已保存')).toBeVisible();
  await panel.getByRole('button', { name: '暂停', exact: true }).click();
  const pause = page.getByRole('dialog', { name: '暂停', exact: true });
  await pause.getByLabel('暂停原因').fill('等法务确认');
  await pause.getByRole('button', { name: '确认暂停' }).click();
  await expect(panel).toContainText('已暂停：等法务确认');
  await panel.getByRole('button', { name: '恢复' }).click();
  await expect(panel).not.toContainText('已暂停');

  await page.getByLabel('写评论').fill('未发送的草稿');
  await page.getByRole('tab', { name: '进展记录' }).click();
  await page.getByRole('tab', { name: '评论' }).click();
  await expect(page.getByLabel('写评论')).toHaveValue('未发送的草稿');
  await page.getByRole('tab', { name: '进展记录' }).click();
  const progress = page.getByRole('region', { name: /^进展记录/ });
  await progress.getByRole('button', { name: '写进展' }).click();
  const dialog = page.getByRole('dialog', { name: '写进展' });
  await expect(dialog.getByLabel('预计上线日期')).toHaveValue('2026-11-30');
  await dialog.getByLabel('进展').fill('完成方案评审');
  await dialog.getByLabel('下一步').fill('拆分任务');
  await dialog.getByRole('button', { name: '保存' }).click();
  const list = progress.getByRole('list', { name: '进展记录列表' });
  await expect(list).toContainText('完成方案评审');
  await expect(list).toContainText('下一步：拆分任务');
  await list.getByRole('button', { name: '修改' }).click();
  await list.getByLabel('修改进展').fill('完成方案评审与排期');
  await list.getByRole('button', { name: '保存' }).click();
  await expect(list).toContainText('完成方案评审与排期');
  await expect(list).toContainText('（已编辑）');
  await list.getByRole('button', { name: '删除' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '删除' }).click();
  await expect(progress).toContainText('还没有进展记录');

  await panel.getByRole('button', { name: '移出跟进' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '移出' }).click();
  await expect(panel).toContainText('已移出跟进');
  await expectNoPageOverflow(page);
});

test('组织设置「跟进」：无效值显示错误；修改阈值后任务老化标色随之变化；成员无权访问', async ({ page, request, browser }) => {
  const { zhang } = await seed(request);
  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme/settings/tracking');
  const warn = page.getByLabel('标黄：本阶段停留超过（天）');
  await expect(warn).toHaveValue('14');
  await warn.fill('30');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByRole('alert').filter({ hasText: '标黄天数应小于标红天数' })).toBeVisible();
  await warn.fill('25');
  await page.getByLabel('标红：本阶段停留超过（天）').fill('40');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText('已保存')).toBeVisible();
  await expectNoPageOverflow(page);
  await page.goto('/acme/tracking?tab=aging');
  const row = page.getByRole('region', { name: '按本阶段停留排序' }).getByRole('row', { name: /开发中的需求/ });
  await expect(row.locator('span', { hasText: /^20 天$/ })).not.toHaveClass(/bg-amber-100/);

  const ctx = await browser.newContext();
  const member = await ctx.newPage();
  await acceptInvite(member, request, { email: 'member@example.com', orgRole: 'member', name: '成员乙' });
  await member.goto('/acme/settings/tracking');
  await expect(member.getByRole('heading', { name: '无权访问' })).toBeVisible();
  await ctx.close();
  await zhang.ctx.dispose();
});
