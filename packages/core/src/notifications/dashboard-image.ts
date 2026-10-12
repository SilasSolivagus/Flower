import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ChannelPayload } from './constants';

/**
 * 概览卡片附带的看板图片：按固定版式排成 SVG（satori），再转为 PNG（resvg），不使用浏览器。
 * 字体为思源黑体（Noto Sans SC）常规与粗体，由 scripts/fetch-fonts.sh 下载；目录先取 FLOWER_FONT_DIR，
 * 否则从当前目录向上找 packages/core/assets/fonts。找不到字体时不生成图片。
 */

/** 需求按状态统计的五类；延期为遗留下期的行。 */
export const DASHBOARD_STATUSES = ['todo', 'doing', 'testing', 'done', 'deferred'] as const;
export type DashboardStatus = (typeof DASHBOARD_STATUSES)[number];
export const DASHBOARD_STATUS_LABELS: Record<DashboardStatus, string> = { todo: '待开发', doing: '开发中', testing: '测试中', done: '已完成', deferred: '延期' };

export type DashboardRow = {
  title: string;
  status: DashboardStatus;
  people: string;
  progress: number;
  /** 进度落后于理论进度（或遗留下期）且未完成。 */
  behind: boolean;
  /** 优先级为 P0 / P1。 */
  starred: boolean;
};

export type DashboardData = {
  brand: string;
  /** 「MM/DD 发版，还剩 N 个工作日」等。 */
  headline: string;
  /** 「{标题前缀} · {迭代名}」。 */
  subtitle: string;
  overall: number;
  expected: number;
  /** 燃尽：迭代的工作日数，今天是第几个工作日（0 为开始日），今天的剩余百分比。没有历史进度，只画理论线与今天一个点。 */
  burndown: { days: number; today: number; remaining: number };
  counts: Record<DashboardStatus, number>;
  rows: DashboardRow[];
  rowTotal: number;
  attention: string[];
  footer: string;
};

/** 企微图片消息的原图上限。 */
export const DASHBOARD_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const DASHBOARD_MAX_ROWS = 8;
const MAX_ATTENTION = 4;

const C = {
  ink: '#1F2329',
  sub: '#646A73',
  mute: '#8F959E',
  line: '#E8EAED',
  bg: '#F5F6F7',
  card: '#FFFFFF',
  blue: '#3370FF',
  blueBg: '#E1EAFF',
  green: '#2EA121',
  greenBg: '#D9F5D6',
  orange: '#E8790B',
  orangeBg: '#FFF7EC',
  red: '#E22E28',
  redBg: '#FDE2E2',
  purple: '#7F3BF5',
  purpleBg: '#ECE2FE',
  grayBg: '#EFF0F1',
  star: '#F5A623',
};

const STATUS_COLORS: Record<DashboardStatus, [string, string]> = {
  todo: [C.sub, C.grayBg],
  doing: [C.blue, C.blueBg],
  testing: [C.purple, C.purpleBg],
  done: [C.green, C.greenBg],
  deferred: [C.red, C.redBg],
};

type Style = Record<string, string | number>;
type Node = { type: string; props: Record<string, unknown> };
type Child = Node | null | false | Array<Node | null | false>;

const h = (style: Style, ...children: Child[]): Node => ({
  type: 'div',
  props: { style: { display: 'flex', ...style }, children: children.flat().filter((c): c is Node => c !== null && c !== false) },
});
const t = (style: Style, text: string | number): Node => ({ type: 'div', props: { style: { display: 'flex', ...style }, children: String(text) } });
/** 按字宽估算截断：中文等全角字符按 1 个字号宽，其余按 0.6 个；超出时以「…」结尾。 */
export function fitText(text: string, width: number, fontSize: number): string {
  const w = (ch: string) => (/[\u2E80-\uFFEF]/.test(ch) ? fontSize : fontSize * 0.6);
  const chars = [...text];
  if (chars.reduce((sum, ch) => sum + w(ch), 0) <= width) return text;
  let used = fontSize;
  let out = '';
  for (const ch of chars) {
    if (used + w(ch) > width) break;
    used += w(ch);
    out += ch;
  }
  return `${out}…`;
}
/** 单行文字，超出宽度以「…」结尾（satori 的 text-overflow 会把省略号截掉一半，这里先按字宽截断）。 */
const line = (style: Style & { fontSize: number }, text: string, width: number): Node =>
  t({ ...style, maxWidth: width, overflow: 'hidden', whiteSpace: 'nowrap' }, fitText(text, width, style.fontSize));
const pill = (text: string, fg: string, bg: string, size: number): Node => t({ fontSize: size, color: fg, backgroundColor: bg, borderRadius: 8, padding: '4px 12px' }, text);

const clamp = (n: number) => Math.min(100, Math.max(0, Math.round(n)));
const barColor = (r: DashboardRow) => (r.progress >= 100 ? C.green : r.behind ? C.orange : C.blue);

function burnSvg(b: DashboardData['burndown']): string {
  const W = 220;
  const H = 96;
  const pad = 6;
  const days = Math.max(1, b.days);
  const x = (i: number) => pad + (Math.min(i, days) * (W - 2 * pad)) / days;
  const y = (v: number) => pad + ((100 - clamp(v)) * (H - 2 * pad)) / 100;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
<rect x="0" y="0" width="${W}" height="${H}" rx="8" fill="${C.bg}"/>
<line x1="${x(0)}" y1="${y(100)}" x2="${x(days)}" y2="${y(0)}" stroke="${C.mute}" stroke-width="1.5" stroke-dasharray="4 4"/>
<circle cx="${x(b.today)}" cy="${y(b.remaining)}" r="5" fill="${C.orange}"/>
</svg>`;
}

function layout(d: DashboardData): Node {
  const behind = Math.max(0, d.expected - d.overall);
  const rowsLabel = d.rows.length < d.rowTotal ? `${d.rows.length} / ${d.rowTotal} 项` : `${d.rowTotal} 项`;
  return h(
    { width: 798, flexDirection: 'column', backgroundColor: C.bg, padding: 24, fontFamily: 'Noto Sans SC' },
    h(
      { flexDirection: 'column', backgroundColor: C.card, borderRadius: 20, padding: '28px 30px' },
      // 标题区：发版信息、整体进度与理论进度、燃尽小图
      h(
        { justifyContent: 'space-between', alignItems: 'flex-start' },
        h(
          { flexDirection: 'column', flex: 1, minWidth: 0 },
          t({ fontSize: 20, color: C.mute }, d.brand),
          line({ fontSize: 30, fontWeight: 700, color: C.ink, marginTop: 6 }, d.headline, 480),
          line({ fontSize: 20, color: C.sub, marginTop: 4 }, d.subtitle, 480),
          h(
            { alignItems: 'flex-end', marginTop: 14 },
            t({ fontSize: 64, fontWeight: 700, color: behind > 5 ? C.orange : C.green, lineHeight: 1 }, `${d.overall}%`),
            h(
              { flexDirection: 'column', alignItems: 'flex-start', marginLeft: 16, marginBottom: 4 },
              t({ fontSize: 20, color: C.sub, marginBottom: 6 }, `整体进度　理论 ${d.expected}%`),
              behind > 0 ? pill(`落后 ${behind}%`, C.red, C.redBg, 18) : pill('进度正常', C.green, C.greenBg, 18),
            ),
          ),
        ),
        h(
          { flexDirection: 'column', alignItems: 'flex-end', marginLeft: 16 },
          { type: 'img', props: { src: `data:image/svg+xml;utf8,${encodeURIComponent(burnSvg(d.burndown))}`, width: 220, height: 96 } },
          h({ marginTop: 6, fontSize: 16, color: C.mute }, t({ color: C.orange, marginRight: 10 }, '● 实际'), t({}, '- - 理论')),
        ),
      ),
      // 按状态统计
      h(
        { marginTop: 24, justifyContent: 'space-between' },
        DASHBOARD_STATUSES.map((s) =>
          h(
            { width: 124, flexDirection: 'column', alignItems: 'center', backgroundColor: STATUS_COLORS[s][1], borderRadius: 14, padding: '12px 0' },
            t({ fontSize: 34, fontWeight: 700, color: STATUS_COLORS[s][0] }, d.counts[s]),
            t({ fontSize: 18, color: STATUS_COLORS[s][0], marginTop: 2 }, DASHBOARD_STATUS_LABELS[s]),
          ),
        ),
      ),
      // 重点需求
      h({ marginTop: 26, alignItems: 'center' }, t({ fontSize: 24, fontWeight: 700, color: C.ink }, '重点需求'), t({ fontSize: 20, color: C.mute, marginLeft: 10 }, rowsLabel)),
      d.rows.length === 0
        ? t({ fontSize: 20, color: C.mute, marginTop: 12 }, '本迭代还没有任务')
        : h(
            { flexDirection: 'column', marginTop: 8 },
            d.rows.map((r, i) =>
              h(
                { alignItems: 'center', padding: '14px 0', borderTop: i === 0 ? 'none' : `1px solid ${C.line}` },
                t({ fontSize: 22, color: C.star, width: 30 }, r.starred ? '★' : ''),
                h(
                  { flexDirection: 'column', width: 380 },
                  line({ fontSize: 22, color: C.ink }, r.title, 380),
                  h(
                    { alignItems: 'center', marginTop: 6 },
                    pill(DASHBOARD_STATUS_LABELS[r.status], STATUS_COLORS[r.status][0], STATUS_COLORS[r.status][1], 16),
                    line({ fontSize: 17, color: C.mute, marginLeft: 10 }, r.people, 260),
                  ),
                ),
                h(
                  { flex: 1, alignItems: 'center', justifyContent: 'flex-end' },
                  h(
                    { width: 150, height: 10, borderRadius: 5, backgroundColor: C.grayBg },
                    h({ width: Math.max(clamp(r.progress), 2) * 1.5, height: 10, borderRadius: 5, backgroundColor: barColor(r) }),
                  ),
                  t({ fontSize: 20, fontWeight: 700, color: barColor(r), width: 84, justifyContent: 'flex-end' }, `${clamp(r.progress)}%`),
                ),
              ),
            ),
          ),
      // 需要关注
      d.attention.length > 0 &&
        h(
          { flexDirection: 'column', marginTop: 14, backgroundColor: C.orangeBg, borderRadius: 14, padding: '16px 18px' },
          t({ fontSize: 20, fontWeight: 700, color: C.orange }, '需要关注'),
          d.attention.slice(0, MAX_ATTENTION).map((a) => line({ fontSize: 19, color: C.ink, marginTop: 8 }, `· ${a}`, 660)),
        ),
      t({ fontSize: 17, color: C.mute, marginTop: 20, justifyContent: 'center' }, d.footer),
    ),
  );
}

type Font = { name: string; data: Buffer; weight: 400 | 700; style: 'normal' };
const FONT_FILES = [
  { file: 'NotoSansSC-Regular.otf', weight: 400 },
  { file: 'NotoSansSC-Bold.otf', weight: 700 },
] as const;
const fontCache = new Map<string, Font[]>();

/** 字体目录：FLOWER_FONT_DIR，否则从当前目录向上找 packages/core/assets/fonts。 */
export function fontDir(): string {
  if (process.env.FLOWER_FONT_DIR) return process.env.FLOWER_FONT_DIR;
  let dir = process.cwd();
  for (;;) {
    const candidate = path.join(dir, 'packages', 'core', 'assets', 'fonts');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return path.join(process.cwd(), 'packages', 'core', 'assets', 'fonts');
    dir = parent;
  }
}

/** 读取字体（按目录缓存）；缺少任一文件时返回 null。 */
function loadFonts(): Font[] | null {
  const dir = fontDir();
  const cached = fontCache.get(dir);
  if (cached) return cached;
  if (!FONT_FILES.every((f) => existsSync(path.join(dir, f.file)))) return null;
  const fonts = FONT_FILES.map((f) => ({ name: 'Noto Sans SC', data: readFileSync(path.join(dir, f.file)), weight: f.weight, style: 'normal' as const }));
  fontCache.set(dir, fonts);
  return fonts;
}

export const FONT_MISSING = '找不到看板图片的字体文件（执行 scripts/fetch-fonts.sh 或设置 FLOWER_FONT_DIR）';

/** 生成看板 PNG；找不到字体时记一条警告并返回 null。 */
export async function renderDashboardPng(data: DashboardData): Promise<Buffer | null> {
  const fonts = loadFonts();
  if (!fonts) {
    console.warn(`[notify] ${FONT_MISSING}`);
    return null;
  }
  // 按需加载：迁移工具等不发图片的入口打包 @flower/core 时不需要解析原生模块
  const [{ default: satori }, { Resvg }] = await Promise.all([import('satori'), import('@resvg/resvg-js')]);
  const svg = await satori(layout(data) as Parameters<typeof satori>[0], { width: 798, fonts });
  return new Resvg(svg, { fitTo: { mode: 'width', value: 1596 } }).render().asPng();
}

/** PNG → 企微图片消息（base64 与原图 md5）；没有图片或超过 2MB 时返回不发送的原因。 */
export function wecomImagePayload(png: Buffer | null): { payload: ChannelPayload } | { skipped: string } {
  if (!png) return { skipped: FONT_MISSING };
  if (png.length > DASHBOARD_IMAGE_MAX_BYTES) return { skipped: `图片 ${Math.round(png.length / 1024)} KB，超过企业微信 2MB 的上限` };
  return { payload: { type: 'json', body: { msgtype: 'image', image: { base64: png.toString('base64'), md5: createHash('md5').update(png).digest('hex') } } } };
}
