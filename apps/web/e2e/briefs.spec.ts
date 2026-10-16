import { readFile } from 'node:fs/promises';
import { expect, type Page, test } from '@playwright/test';
import { resetDatabase } from './db';
import { createBrief, createMember, createProduct, createRequirement, expectNoPageOverflow, json, login, ok, OWNER, setupInstance } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetDatabase();
  await setupInstance(request);
});

/**
 * 按模板写好的简报正文（虚构内容）：第 1–13 节各写结论（第 5、7、12 节写「不适用：理由」），第 8 节一条有证据与日期的现状，
 * 第 16 节一个不阻塞的问题；第 14 节放在最后，只写「不适用：」——闸口第 1 项因此不通过。
 */
function filledBrief(): string {
  const sections = [
    '## 1. 问题与目标\n\n上传失败率 3%，目标降到 1%。',
    '## 2. 数据依据\n\n近 30 天的上传日志。',
    '## 3. 受影响用户\n\n上传大文件的用户约 2 万人。',
    '## 4. 场景清单\n\n断点续传。',
    '## 5. 对象与状态\n\n不适用：只有上传任务一种对象。',
    '## 6. 规则与方案\n\n失败后自动重试三次。',
    '## 7. 计算口径与算法\n\n不适用：不涉及计数。',
    '## 8. 现状核对\n\n| # | 要核对的现状 | 结论 | 证据（仓库 文件:行号 / 提交号） | 核对日期 | 和他人说法的差异 |\n| --- | --- | --- | --- | --- | --- |\n| 1 | 重试次数 | 目前不重试 | web/upload.ts:42 | 2026-10-10 | |',
    '## 9. 可行性与性能\n\n研发评估可行。',
    '## 10. 影响面与兼容\n\nWeb 与 PC 客户端。',
    '## 11. 用户感知与触达\n\n失败时提示正在重试。',
    '## 12. 商业与合规\n\n不适用：不涉及付费。',
    '## 13. 上线策略\n\n灰度 10%。',
    '## 15. 决策日志\n\n重试三次。',
    '## 16. 待定问题\n\n| # | 问题 | 选项 | 建议 | 待谁定 | 是否阻塞 PRD |\n| --- | --- | --- | --- | --- | --- |\n| 1 | 重试间隔 | 1 秒 / 3 秒 | 3 秒 | 后端 | 否 |',
    '## 17. 写 PRD 闸口\n\n见侧栏。',
    '## 18. 与 PRD 章节的对应\n\n见模板。',
    '## 14. 分工\n\n不适用：',
  ];
  return `${sections.join('\n\n')}\n`;
}

/** 在正文末尾输入一段文字，等自动保存的 PUT 返回。 */
async function typeAtEnd(page: Page, docId: string, text: string) {
  const saved = page.waitForResponse((r) => r.url().endsWith(`/documents/${docId}/content`) && r.request().method() === 'PUT');
  await page.getByRole('region', { name: '正文' }).locator('.bn-block-content').last().click();
  await page.keyboard.press('End');
  await page.keyboard.type(text);
  return saved;
}

test('从需求新建简报：头部信息、正文与闸口、转 PRD 与互链、复制与下载 Markdown；PRD 区块不接受简报编号', async ({ page, request }) => {
  const productId = await createProduct(request);
  await createRequirement(request, productId, '上传失败自动重试');
  await createRequirement(request, productId, '下载限速');
  await createMember(request, '决策人甲');
  await login(page, OWNER.email, OWNER.password);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);

  await page.goto('/acme/requirements/PAN-1');
  const card = page.getByRole('region', { name: '简报', exact: true });
  await expect(card).toContainText('还没有简报');
  await card.getByRole('button', { name: '新建简报' }).click();
  const dialog = page.getByRole('dialog', { name: '新建简报' });
  await expect(dialog.getByLabel('标题')).toHaveValue('上传失败自动重试');
  await dialog.getByRole('button', { name: '创建' }).click();
  await page.waitForURL('**/acme/documents/PAN-B-1');
  await expect(page.getByRole('region', { name: '模板说明' })).toContainText('不是会议流水账');
  await expect(page.getByRole('region', { name: '正文' })).toContainText('1. 问题与目标');
  const side = page.getByRole('complementary');
  await expect(side.getByRole('region', { name: '状态' })).toContainText('讨论中');
  await expect(side.getByRole('region', { name: '覆盖的需求' })).toContainText('PAN-1');

  // 头部信息：版本、决策人、参与方、关联文档
  const header = side.getByRole('region', { name: '头部信息' });
  await header.getByLabel('版本').fill('v0.2');
  await header.getByLabel('版本').press('Enter');
  await header.getByRole('combobox', { name: '决策人' }).click();
  await page.getByRole('option', { name: '决策人甲' }).click();
  await expect(header.getByRole('combobox', { name: '决策人' })).toHaveText('决策人甲');
  await header.getByRole('button', { name: '参与方' }).click();
  await page.getByRole('checkbox', { name: '开发' }).click();
  await page.keyboard.press('Escape');
  await expect(header).toContainText('开发');
  await header.getByLabel('引用或网址').fill('PAN-2');
  await header.getByLabel('说明').fill('相关需求');
  await header.getByRole('button', { name: '添加' }).click();
  await expect(header.getByRole('list', { name: '关联文档' }).getByRole('link', { name: 'PAN-2' })).toHaveAttribute('href', '/acme/requirements/PAN-2');

  // 正文：接口写入按模板填好的内容后刷新；第 14 节只写了「不适用：」
  const brief = await json<{ document: { id: string; version: number } }>(request.get('/api/v1/orgs/acme/documents/PAN-B-1'));
  await ok(request.put(`/api/v1/orgs/acme/documents/${brief.document.id}/content`, { data: { baseVersion: brief.document.version, markdown: filledBrief() } }));
  await page.reload();
  await expect(header.getByLabel('版本')).toHaveValue('v0.2');
  const gate = side.getByRole('region', { name: '写 PRD 闸口' });
  await expect(gate).toContainText('2/11');
  await expect(gate.getByRole('listitem', { name: '闸口 1', exact: true })).toContainText('「14. 分工」写了「不适用」但没有写理由');
  await expect(gate.getByRole('listitem', { name: '闸口 7', exact: true }).getByLabel('通过', { exact: true })).toBeVisible();

  // 在编辑器里补上理由：自动保存后闸口第 1 项通过
  expect((await typeAtEnd(page, brief.document.id, '暂不涉及分工')).ok()).toBeTruthy();
  await expect(gate).toContainText('3/11');
  await expect(gate.getByRole('listitem', { name: '闸口 1', exact: true }).getByLabel('通过', { exact: true })).toBeVisible();

  // 人工勾选
  await gate.getByRole('checkbox', { name: '勾选闸口 2' }).click();
  await expect(gate).toContainText('4/11');
  await expect(gate.getByRole('listitem', { name: '闸口 2', exact: true })).toContainText(OWNER.name);

  // 复制与下载 Markdown
  const actions = side.getByRole('region', { name: '操作' });
  await actions.getByRole('button', { name: '复制为 Markdown' }).click();
  await expect(page.getByText('已复制 Markdown')).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain('# PAN-B-1 上传失败自动重试');
  expect(copied).toContain('| 决策人 | 决策人甲 |');
  expect(copied).toContain('## 写 PRD 闸口（4/11）');
  const downloading = page.waitForEvent('download');
  await actions.getByRole('button', { name: '下载 .md' }).click();
  const file = await downloading;
  expect(file.suggestedFilename()).toBe('PAN-B-1 上传失败自动重试.md');
  expect(await readFile(await file.path(), 'utf8')).toContain('## 正文');

  // 转 PRD：先列出没通过的闸口项，生成后跳到 PRD，两边互相链接
  await actions.getByRole('button', { name: '转 PRD' }).click();
  const conv = page.getByRole('dialog', { name: '转 PRD' });
  await expect(conv).toContainText('以下闸口项还没有通过');
  await expect(conv).toContainText('3. 第 3 节已估出影响人数和付费用户占比');
  await conv.getByRole('button', { name: '生成 PRD 草稿' }).click();
  await page.waitForURL('**/acme/documents/PAN-PRD-1');
  const source = page.getByRole('note', { name: '来源简报' });
  await expect(source).toContainText('由简报 PAN-B-1 生成');
  await expect(page.getByRole('region', { name: '正文' })).toContainText('来自简报第 1 节「问题与目标」');
  await expect(page.getByRole('complementary').getByRole('region', { name: '覆盖的需求' })).toContainText('PAN-1');
  await source.getByRole('link', { name: 'PAN-B-1' }).click();
  await page.waitForURL('**/acme/documents/PAN-B-1');
  await expect(side.getByRole('region', { name: '状态' })).toContainText('已转 PRD');
  await expect(actions).toContainText('已转为 PAN-PRD-1');

  // 再转：提示已有 PRD，可以打开或再生成；需求已在 PAN-PRD-1 上，结果里列出
  await actions.getByRole('button', { name: '转 PRD' }).click();
  await expect(conv).toContainText('这份简报已转为 PAN-PRD-1');
  await expect(conv.getByRole('link', { name: '打开 PAN-PRD-1' })).toBeVisible();
  await conv.getByRole('button', { name: '再生成一份新草稿' }).click();
  await page.waitForURL('**/acme/documents/PAN-PRD-2');
  await expect(page.getByText('以下需求已挂在其他 PRD 上，没有覆盖：PAN-1（PAN-PRD-1）')).toBeVisible();

  // 需求详情的「简报」区块；「PRD」区块不接受简报编号
  await page.goto('/acme/requirements/PAN-1');
  const briefCard = page.getByRole('region', { name: '简报', exact: true });
  await expect(briefCard.getByRole('link', { name: /PAN-B-1/ })).toBeVisible();
  await expect(briefCard).toContainText('已转 PRD');
  await expect(briefCard).toContainText('闸口 4/11');
  await page.goto('/acme/requirements/PAN-2');
  const prdCard = page.getByRole('region', { name: 'PRD', exact: true });
  await prdCard.getByRole('button', { name: '关联已有 PRD' }).click();
  await prdCard.getByLabel('PRD 编号').fill('PAN-B-1');
  await prdCard.getByRole('button', { name: '关联' }).click();
  await expect(prdCard.getByRole('alert')).toContainText('请输入 PRD 编号，例如 PAN-PRD-1');
});

test('文档页「简报」页签：列表、状态与决策人筛选（写入地址栏）、新建；1440 与 760 下列表与详情不横向滚动', async ({ page, request }) => {
  const productId = await createProduct(request);
  const deciderId = await createMember(request, '决策人甲');
  const a = await createBrief(request, productId, { title: '上传提速' });
  const b = await createBrief(request, productId, { title: '下载限速' });
  await ok(request.patch(`/api/v1/orgs/acme/briefs/${a.id}`, { data: { deciderMemberId: deciderId } }));
  await ok(request.post(`/api/v1/orgs/acme/documents/${b.id}/transitions`, { data: { to: 'ready' } }));
  await login(page, OWNER.email, OWNER.password);

  await page.goto('/acme/documents');
  await page.getByRole('tab', { name: '简报' }).click();
  await page.waitForURL(/view=briefs/);
  const rowA = page.getByRole('row', { name: /PAN-B-1/ });
  const rowB = page.getByRole('row', { name: /PAN-B-2/ });
  await expect(rowA).toContainText('上传提速');
  await expect(rowA).toContainText('2/11');
  await expect(rowA).toContainText('决策人甲');
  await expect(rowB).toContainText('可写 PRD');

  await page.getByRole('combobox', { name: '状态' }).click();
  await page.getByRole('option', { name: '可写 PRD' }).click();
  await expect(page).toHaveURL(/status=ready/);
  await expect(rowB).toBeVisible();
  await expect(rowA).toHaveCount(0);

  await page.getByRole('combobox', { name: '状态' }).click();
  await page.getByRole('option', { name: '全部状态' }).click();
  await page.getByRole('combobox', { name: '决策人' }).click();
  await page.getByRole('option', { name: '决策人甲' }).click();
  await expect(page).toHaveURL(/decider=/);
  await page.reload();
  await expect(rowA).toBeVisible();
  await expect(rowB).toHaveCount(0);

  await page.getByRole('button', { name: '新建简报' }).click();
  const dialog = page.getByRole('dialog', { name: '新建简报' });
  await dialog.getByLabel('标题').fill('分享有效期');
  await dialog.getByRole('button', { name: '创建' }).click();
  await page.waitForURL('**/acme/documents/PAN-B-3');
  await expect(page.getByRole('region', { name: '正文' })).toContainText('18. 与 PRD 章节的对应');

  for (const width of [1440, 760]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/acme/documents?product=PAN&view=briefs');
    await expect(page.getByRole('row', { name: /PAN-B-3/ })).toBeVisible();
    await expectNoPageOverflow(page);
    await page.goto('/acme/documents/PAN-B-1');
    await expect(page.getByRole('complementary').getByRole('region', { name: '写 PRD 闸口' })).toContainText('2/11');
    await expectNoPageOverflow(page);
  }
});

test('模板设置：切换到简报模板，看到预置简报模板的必填小节与模板说明', async ({ page }) => {
  await login(page, OWNER.email, OWNER.password);
  await page.goto('/acme/settings/templates');
  await expect(page.getByRole('row', { name: /变更 PRD（预置）/ })).toBeVisible();
  await page.getByRole('combobox', { name: '模板类型' }).click();
  await page.getByRole('option', { name: '简报模板' }).click();
  const row = page.getByRole('row', { name: /需求简报（预置）/ });
  await expect(row).toContainText('1. 问题与目标、2. 数据依据');
  await row.getByRole('button', { name: '编辑' }).click();
  const dialog = page.getByRole('dialog', { name: '编辑模板' });
  await expect(dialog.getByLabel('模板说明')).toHaveValue(/不是会议流水账/);
  await expect(dialog.getByLabel('小节 18 标题')).toHaveValue('18. 与 PRD 章节的对应');
});
