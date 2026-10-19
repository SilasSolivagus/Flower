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
    '## 17. 写 PRD 前检查\n\n见侧栏。',
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
  await expect(page.getByRole('region', { name: '模板说明' })).toContainText('未勾完也能生成');
  await expect(page.getByRole('region', { name: '正文' })).toContainText('1. 问题与目标');
  const side = page.getByRole('complementary');
  await expect(side.getByRole('region', { name: '状态' })).toContainText('讨论中');
  await expect(side.getByRole('region', { name: '关联的需求' })).toContainText('PAN-1');
  await expect(page.getByText('不涉及的小节写成一行：不涉及：……理由')).toBeVisible();

  // 确认人是当前用户时，标题下有任务条
  const me = await json<{ me: { memberId: string } }>(request.get('/api/v1/orgs/acme'));
  await ok(request.patch(`/api/v1/orgs/acme/briefs/${(await json<{ document: { id: string } }>(request.get('/api/v1/orgs/acme/documents/PAN-B-1'))).document.id}`, { data: { deciderMemberId: me.me.memberId } }));
  await page.reload();
  await expect(page.getByRole('status', { name: '待确认' })).toContainText('请确认问题、规则、指标与上线策略');

  // 基本信息：版本、确认人、参与角色、关联文档
  const header = side.getByRole('region', { name: '基本信息' });
  await header.getByLabel('版本').fill('v0.2');
  await header.getByLabel('版本').press('Enter');
  await header.getByRole('combobox', { name: '确认人' }).click();
  await page.getByRole('option', { name: '决策人甲' }).click();
  await expect(header.getByRole('combobox', { name: '确认人' })).toHaveText('决策人甲');
  await expect(page.getByRole('status', { name: '待确认' })).toHaveCount(0);
  await header.getByRole('button', { name: '参与角色' }).click();
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
  const gate = side.getByRole('region', { name: '写 PRD 前检查' });
  await expect(gate.getByRole('note')).toContainText('未勾完也可以生成 PRD。');
  await expect(gate).toContainText('2/11，还差 9 项');
  await expect(gate).toContainText('系统 2 · 人工 0');
  await expect(gate.getByRole('listitem', { name: '检查 1', exact: true })).toContainText('「14. 分工」写了不涉及，但还没写理由');
  await expect(gate.getByRole('listitem', { name: '检查 7', exact: true }).getByLabel('通过', { exact: true })).toBeVisible();
  await gate.getByRole('button', { name: '去改「14. 分工」' }).click();
  await expect(page.locator('.brief-section-target')).toBeVisible();
  await expect(page).not.toHaveURL(/[?&]section=/);
  await page.reload();
  await expect(page).not.toHaveURL(/[?&]section=/);
  await expect(page.locator('.brief-section-target')).toHaveCount(0);

  // 在编辑器里补上理由：自动保存后检查第 1 项通过
  expect((await typeAtEnd(page, brief.document.id, '暂不涉及分工')).ok()).toBeTruthy();
  await expect(gate).toContainText('3/11，还差 8 项');
  await expect(gate.getByRole('listitem', { name: '检查 1', exact: true }).getByLabel('通过', { exact: true })).toBeVisible();

  // 人工勾选
  await gate.getByRole('checkbox', { name: '勾选检查 2' }).click();
  await expect(gate).toContainText('4/11，还差 7 项');
  await expect(gate.getByRole('listitem', { name: '检查 2', exact: true })).toContainText(OWNER.name);

  // 复制与下载文本
  const actions = side.getByRole('region', { name: '操作' });
  await actions.getByRole('button', { name: '复制为文本' }).click();
  await expect(page.getByText('已复制文本')).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain('# PAN-B-1 上传失败自动重试');
  expect(copied).toContain('| 确认人 | 决策人甲 |');
  expect(copied).toContain('## 写 PRD 前检查（4/11，还差 7 项）');
  const downloading = page.waitForEvent('download');
  await actions.getByRole('button', { name: '下载 .md' }).click();
  const file = await downloading;
  expect(file.suggestedFilename()).toBe('PAN-B-1 上传失败自动重试.md');
  expect(await readFile(await file.path(), 'utf8')).toContain('## 正文');

  // 生成 PRD：先列出没勾完的检查项，生成后跳到 PRD，两边互相链接
  await actions.getByRole('button', { name: '生成 PRD' }).click();
  const conv = page.getByRole('dialog', { name: '生成 PRD' });
  await expect(conv).toContainText('还有这些没勾完（仍可生成）');
  await expect(conv).toContainText('3. 第 3 节已估出影响人数和付费用户占比');
  await conv.getByRole('button', { name: '生成 PRD' }).click();
  await page.waitForURL('**/acme/documents/PAN-PRD-1');
  const source = page.getByRole('note', { name: '来源简报' });
  await expect(source).toContainText('由简报 PAN-B-1 生成');
  await expect(page.getByRole('region', { name: '正文' })).toContainText('来自简报第 1 节「问题与目标」');
  await expect(page.getByRole('complementary').getByRole('region', { name: '覆盖的需求' })).toContainText('PAN-1');
  await source.getByRole('link', { name: 'PAN-B-1' }).click();
  await page.waitForURL('**/acme/documents/PAN-B-1');
  await expect(side.getByRole('region', { name: '状态' })).toContainText('已生成 PRD');
  await expect(actions).toContainText('已生成 PAN-PRD-1');
  await expect(actions.getByRole('link', { name: '打开当前 PRD' })).toBeVisible();
  await expect(actions).toContainText('已关联的需求不会挂到新草稿');
  await expect(gate.getByRole('note')).toHaveCount(0);

  // 再生成：主按钮是打开当前 PRD；需求已在 PAN-PRD-1 上，结果里列出
  await actions.getByRole('button', { name: '再生成一份草稿' }).click();
  await expect(conv).toContainText('已生成');
  await expect(conv).toContainText('不会挂到新草稿');
  await expect(conv.getByRole('link', { name: '打开当前 PRD' })).toBeVisible();
  await conv.getByRole('button', { name: '再生成一份草稿' }).click();
  await page.waitForURL('**/acme/documents/PAN-PRD-2');
  await expect(page.getByText('以下需求已挂在其他 PRD 上，未关联到新 PRD：PAN-1（PAN-PRD-1）')).toBeVisible();

  // 需求详情的「简报」区块；「PRD」区块不接受简报编号
  await page.goto('/acme/requirements/PAN-1');
  const briefCard = page.getByRole('region', { name: '简报', exact: true });
  await expect(briefCard.getByRole('link', { name: /PAN-B-1/ })).toBeVisible();
  await expect(briefCard).toContainText('已生成 PRD');
  await expect(briefCard).toContainText('检查 4/11，还差 7 项');
  await page.goto('/acme/requirements/PAN-2');
  const prdCard = page.getByRole('region', { name: 'PRD', exact: true });
  await prdCard.getByRole('button', { name: '关联已有 PRD' }).click();
  await prdCard.getByLabel('PRD 编号').fill('PAN-B-1');
  await prdCard.getByRole('button', { name: '关联' }).click();
  await expect(prdCard.getByRole('alert')).toContainText('请输入 PRD 编号，例如 PAN-PRD-1');
});

test('文档页「简报」页签：列表、状态与决策人筛选（写入地址栏）、新建；1440 与 760 下列表、含宽表的详情与需求详情不横向滚动', async ({ page, request }) => {
  const productId = await createProduct(request);
  await createRequirement(request, productId, '上传失败自动重试');
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
  await expect(rowB).toContainText('可以写 PRD');

  await page.getByRole('combobox', { name: '状态' }).click();
  await page.getByRole('option', { name: '可以写 PRD' }).click();
  await expect(page).toHaveURL(/status=ready/);
  await expect(rowB).toBeVisible();
  await expect(rowA).toHaveCount(0);

  await page.getByRole('combobox', { name: '状态' }).click();
  await page.getByRole('option', { name: '已废弃' }).click();
  await expect(page.getByText('当前筛选：已废弃')).toBeVisible();
  await page.getByRole('button', { name: '清除筛选' }).click();
  await expect(page).not.toHaveURL(/status=/);
  await expect(rowA).toBeVisible();
  await expect(rowB).toBeVisible();

  await page.getByRole('combobox', { name: '确认人' }).click();
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
    const row = page.getByRole('row', { name: /PAN-B-3/ });
    await expect(row).toBeVisible();
    if (width === 760) {
      await expect.poll(async () => row.getByRole('cell').nth(1).evaluate((el) => el.getBoundingClientRect().width)).toBeGreaterThan(80);
    }
    await expectNoPageOverflow(page);
    await page.goto('/acme/documents/PAN-B-1');
    const body = page.getByRole('region', { name: '正文' });
    // 预置模板第 10 节是 5 列宽表；等编辑器画出来再量，避免骨架屏时误判为不溢出
    await expect(body.getByText('10. 影响面与兼容')).toBeVisible();
    const wideTable = body.locator('table').filter({ hasText: '端 / 对象' });
    await expect(wideTable).toBeVisible();
    // 表比容器宽时，滚动发生在表格容器里，而不是把页面撑宽后裁切
    await expect
      .poll(() =>
        wideTable.evaluate((table) => {
          const wrap = table.closest('.tableWrapper');
          if (!wrap) return false;
          const overflowX = getComputedStyle(wrap).overflowX;
          const scrolls = overflowX === 'auto' || overflowX === 'scroll';
          return table.scrollWidth <= wrap.clientWidth + 1 || scrolls;
        }),
      )
      .toBe(true);
    await expect(page.getByRole('complementary').getByRole('region', { name: '写 PRD 前检查' })).toContainText('2/11，还差 9 项');
    if (width === 760) await expect(page.getByRole('region', { name: '简报进度' })).toBeVisible();
    await expectNoPageOverflow(page);
    await page.goto('/acme/requirements/PAN-1');
    await expect(page.getByRole('region', { name: '简报', exact: true })).toBeVisible();
    await expectNoPageOverflow(page);
  }

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/acme/documents/PAN-B-3');
  const blocking = page.getByRole('region', { name: '正文' }).getByText('是否阻塞 PRD', { exact: true });
  await expect(blocking).toBeVisible();
  await expect
    .poll(() =>
      blocking.evaluate((el) => {
        const wrap = el.closest('.tableWrapper');
        if (!wrap) return false;
        const cell = el.getBoundingClientRect();
        const box = wrap.getBoundingClientRect();
        return cell.width > 8 && cell.right <= box.right + 2 && cell.left >= box.left - 2;
      }),
    )
    .toBe(true);
  await page.goto('/acme/documents?product=PAN&view=briefs');
  await expectNoPageOverflow(page);
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
  await expect(dialog.getByLabel('模板说明')).toHaveValue(/未勾完也能生成/);
  await expect(dialog.getByLabel('小节 18 标题')).toHaveValue('18. 与 PRD 章节的对应');
  await page.setViewportSize({ width: 760, height: 900 });
  await expectNoPageOverflow(page);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(row).toBeVisible();
  await expectNoPageOverflow(page);
});
