import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DASHBOARD_IMAGE_MAX_BYTES, type DashboardData, fontDir, renderDashboardPng } from '../src/notifications/dashboard-image';

const hasFonts = ['NotoSansSC-Regular.otf', 'NotoSansSC-Bold.otf'].every((f) => existsSync(path.join(fontDir(), f)));
if (!hasFonts) console.warn(`[notify-dashboard-image] 跳过需要字体的用例：${fontDir()} 下没有字体，先执行 ./scripts/fetch-fonts.sh`);

/** 虚构数据：8 行（含超长标题与多人）、4 条需要关注。 */
const sampleDashboard: DashboardData = {
  brand: 'Flower · 研发日报',
  headline: '10/16 发版，还剩 4 个工作日',
  subtitle: '示例产品 研发日报 · 迭代 1016',
  overall: 62,
  expected: 70,
  burndown: { days: 10, today: 6, remaining: 38 },
  counts: { todo: 3, doing: 5, testing: 2, done: 7, deferred: 1 },
  rows: [
    { title: 'DEMO-12 回收站批量清理', status: 'doing', people: '李四 · 孙七', progress: 35, behind: true, starred: true },
    { title: 'DEMO-15 会员到期提醒改版（短信 + 站内）', status: 'todo', people: '周八', progress: 0, behind: true, starred: true },
    { title: 'DEMO-18 大文件预览能力一期：视频与压缩包在线查看，以及文档格式的扩展支持', status: 'deferred', people: '郑十', progress: 18, behind: true, starred: false },
    { title: 'DEMO-3 上传失败自动重试与断点续传', status: 'testing', people: '王五 · 赵六', progress: 100, behind: false, starred: true },
    { title: 'DEMO-7 分享链接有效期与访问次数限制', status: 'doing', people: '张三', progress: 74, behind: false, starred: true },
    { title: 'DEMO-9 客户端设置页重构', status: 'done', people: '吴九', progress: 100, behind: false, starred: false },
    { title: 'DEMO-21 下载列表排序', status: 'doing', people: '钱一 · 陈二 · 褚三 · 卫四 · 蒋五 · 沈六 · 韩七', progress: 80, behind: false, starred: false },
    { title: 'DEMO-22 登录页文案调整', status: 'testing', people: '未分配', progress: 90, behind: false, starred: false },
  ],
  rowTotal: 11,
  attention: [
    'DEMO-12 回收站批量清理 · 李四 · 依赖接口延期两天，需要协调后端排期并确认新的提测时间',
    'DEMO-15 会员到期提醒改版 · 周八 · 未开始',
    'DEMO-18 大文件预览能力一期 · 郑十 · 遗留下期',
    'DEMO-30 示例 · 关注',
  ],
  footer: '完整需求与甘特：点下方卡片「查看甘特」',
};

describe('看板图片', () => {
  afterEach(() => vi.unstubAllEnvs());

  it.skipIf(!hasFonts)('生成 PNG：文件头为 PNG、宽 1596、不超过 2MB', async () => {
    const png = await renderDashboardPng(sampleDashboard);
    expect(png).not.toBeNull();
    expect(png!.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(png!.readUInt32BE(16)).toBe(1596);
    expect(png!.length).toBeLessThan(DASHBOARD_IMAGE_MAX_BYTES);
  });

  it.skipIf(!hasFonts)('没有重点需求与需要关注时也能生成', async () => {
    const png = await renderDashboardPng({ ...sampleDashboard, rows: [], rowTotal: 0, attention: [], burndown: { days: 0, today: 0, remaining: 100 } });
    expect(png!.length).toBeGreaterThan(0);
  });

  it('字体目录里没有字体：返回 null 并记一条警告', async () => {
    const empty = mkdtempSync(path.join(tmpdir(), 'flower-fonts-'));
    vi.stubEnv('FLOWER_FONT_DIR', empty);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await renderDashboardPng(sampleDashboard)).toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('找不到看板图片的字体文件'));
    } finally {
      warn.mockRestore();
      rmSync(empty, { recursive: true });
    }
  });
});
