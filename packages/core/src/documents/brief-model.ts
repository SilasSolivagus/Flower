import { BRIEF_GATE_ITEMS, BRIEF_SECTIONS, BRIEF_TO_PRD } from './brief-template';
import type { BriefGateCheck, BriefRelatedLink, BriefStatus } from './constants';
import { normalizeHeading, plainText, type Section, splitSections, squash } from './markdown';

export type BriefGateItem = {
  no: number;
  label: string;
  auto: boolean;
  passed: boolean;
  /** 自动项未通过的原因；人工项为空。 */
  reasons: string[];
  /** 自动项未通过时可以定位到的小节标题（模板里的写法）。 */
  section: string | null;
  checkedBy: { id: string; displayName: string } | null;
  checkedAt: string | null;
};
export type BriefGate = { items: BriefGateItem[]; passed: number; total: number };

type Check = { reasons: string[]; section: string | null };
type Table = { header: string[]; rows: string[][] };

/** 表格分隔行（含编辑器写出的任意长度分隔线）与分隔线。 */
const RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
/** 一行的比较形式：去掉 Markdown 符号与全部空白；分隔行与空行为空串。编辑器保存时的格式差异（空格、列表符号、转义）都被抹平。 */
const norm = (line: string): string => (RULE.test(line) ? '' : squash(plainText(line.trim())));
/** 小节标题的比较形式：去掉反斜杠（编辑器会写成 `1\.`）、开头的编号与空白。 */
const headKey = (heading: string): string => normalizeHeading(heading.replace(/\\/g, ''));
/** 界面写「不适用：理由」；仍认「不涉及」，避免已写过的简报被判未填。 */
const NOT_APPLICABLE = /^(?:不涉及|不适用)(?:[:：](.*))?$/;

/** 小节及其下级小节的正文行（不含本节标题行）；找不到小节时为 null。 */
function ownLines(sections: Section[], heading: string): string[] | null {
  const want = headKey(heading);
  const i = sections.findIndex((s) => s.heading !== null && headKey(s.heading) === want);
  if (i === -1) return null;
  const lines = sections[i]!.markdown.split('\n').slice(1);
  for (let j = i + 1; j < sections.length && sections[j]!.level > sections[i]!.level; j++) lines.push(...sections[j]!.markdown.split('\n'));
  return lines;
}

/** 去掉模板原样内容之后：没有内容为 blank；只剩「不适用」且没有理由为 no_reason；否则为 filled。 */
function fillState(lines: string[], template: Set<string>): 'filled' | 'blank' | 'no_reason' {
  const own = lines.map(norm).filter((l) => l !== '' && !template.has(l));
  if (own.length === 0) return 'blank';
  return own.every((l) => {
    const m = NOT_APPLICABLE.exec(l);
    return m !== null && !m[1];
  })
    ? 'no_reason'
    : 'filled';
}

const cells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '')
    .split(/(?<!\\)\|/)
    .map(norm);

/** 连续以 | 开头、第二行是分隔行的几行为一张表。 */
function tablesIn(lines: string[]): Table[] {
  const out: Table[] = [];
  let block: string[] = [];
  const flush = () => {
    if (block.length >= 2 && RULE.test(block[1]!)) out.push({ header: cells(block[0]!), rows: block.slice(2).map(cells) });
    block = [];
  };
  for (const l of lines) {
    if (l.trim().startsWith('|')) block.push(l);
    else flush();
  }
  flush();
  return out;
}

const column = (t: Table, prefix: string): number => t.header.findIndex((h) => h.startsWith(prefix));
const rowLabel = (t: Table, r: string[], i: number): string => {
  const c = column(t, '#');
  return (c !== -1 && r[c]) || String(i + 1);
};

function blankCheck(sections: Section[], template: Set<string>): Check {
  const reasons: string[] = [];
  let section: string | null = null;
  for (const s of BRIEF_SECTIONS.slice(0, 14)) {
    const lines = ownLines(sections, s.heading);
    if (!lines) {
      reasons.push(`缺少小节「${s.heading}」`);
      continue;
    }
    const state = fillState(lines, template);
    if (state === 'filled') continue;
    reasons.push(state === 'blank' ? `「${s.heading}」还没有填写` : `「${s.heading}」写了不适用，但还没写理由`);
    section ??= s.heading;
  }
  return { reasons, section };
}

/** 第 no 节的表格逐行检查；缺小节时不通过。 */
function tableCheck(sections: Section[], no: number, rowReasons: (t: Table) => string[]): Check {
  const heading = BRIEF_SECTIONS[no - 1]!.heading;
  const lines = ownLines(sections, heading);
  if (!lines) return { reasons: [`缺少小节「${heading}」`], section: null };
  const reasons = tablesIn(lines).flatMap(rowReasons);
  return { reasons, section: reasons.length > 0 ? heading : null };
}

const evidenceReasons = (t: Table): string[] => {
  const [c, e, d] = [column(t, '结论'), column(t, '证据'), column(t, '核对日期')];
  if (c === -1 || e === -1 || d === -1) return [];
  return t.rows.flatMap((r, i) => {
    if (!r[c]) return [];
    const missing = [...(r[e] ? [] : ['证据']), ...(r[d] ? [] : ['核对日期'])];
    return missing.length > 0 ? [`第 ${rowLabel(t, r, i)} 行缺少「${missing.join('」「')}」`] : [];
  });
};

const blockingReasons = (t: Table): string[] => {
  const b = column(t, '是否阻塞');
  if (b === -1) return [];
  return t.rows.flatMap((r, i) => (r[b] === '是' ? [`第 ${rowLabel(t, r, i)} 个待定问题标为阻塞 PRD`] : []));
};

/**
 * 写 PRD 闸口（设计 §3.5）：自动项按当前正文计算，人工项看勾选记录。templateBody 是简报所用模板的正文，
 * 与模板原样相同的行不算内容。names 为勾选人的当前姓名。
 */
export function evaluateBriefGate(input: { markdown: string; templateBody: string; checks: BriefGateCheck[]; names: Map<string, string> }): BriefGate {
  const sections = splitSections(input.markdown);
  const template = new Set(input.templateBody.split('\n').map(norm).filter((l) => l !== ''));
  const auto: Record<number, () => Check> = {
    1: () => blankCheck(sections, template),
    7: () => tableCheck(sections, 8, evidenceReasons),
    10: () => tableCheck(sections, 16, blockingReasons),
  };
  const items = BRIEF_GATE_ITEMS.map((g): BriefGateItem => {
    if (g.auto) {
      const r = auto[g.no]!();
      return { no: g.no, label: g.label, auto: true, passed: r.reasons.length === 0, reasons: r.reasons, section: r.section, checkedBy: null, checkedAt: null };
    }
    const c = input.checks.find((x) => x.item === g.no);
    return {
      no: g.no,
      label: g.label,
      auto: false,
      passed: !!c,
      reasons: [],
      section: null,
      checkedBy: c ? { id: c.memberId, displayName: input.names.get(c.memberId) ?? '已删除的成员' } : null,
      checkedAt: c?.at ?? null,
    };
  });
  return { items, passed: items.filter((i) => i.passed).length, total: items.length };
}

const sectionName = (heading: string): string => heading.replace(/^\d+\.\s*/, '');

/** 转 PRD（设计 §3.6）：按 BRIEF_TO_PRD 生成章节，每章依次放来源小节的原文，前面用引用块注明来源。 */
export function briefToPrdMarkdown(input: { briefKey: string; markdown: string }): string {
  const sections = splitSections(input.markdown);
  const out: string[] = [`> 由简报 [[${input.briefKey}]] 生成。各章节下的引用块注明内容来自简报的哪一节，请按 PRD 的写法改写后再提交评审。`, ''];
  for (const ch of BRIEF_TO_PRD) {
    out.push(`${'#'.repeat(ch.level)} ${ch.heading}`, '');
    if (ch.note) out.push(`> ${ch.note}`, '');
    for (const no of ch.from) {
      const s = BRIEF_SECTIONS[no - 1]!;
      const text = (ownLines(sections, s.heading) ?? []).join('\n').trim();
      out.push(`> 来自简报第 ${no} 节「${sectionName(s.heading)}」`, '', text || '（简报中这一节为空）', '');
    }
  }
  return `${out.join('\n').trimEnd()}\n`;
}

/** 上下文接口与「复制为 Markdown」的内容（设计 §3.7）。时间为 ISO 字符串。 */
export type BriefContext = {
  brief: {
    id: string;
    displayKey: string;
    title: string;
    status: BriefStatus;
    statusLabel: string;
    product: { key: string; name: string };
    version: string;
    requester: string | null;
    decider: string | null;
    author: string | null;
    participants: string[];
    relatedLinks: BriefRelatedLink[];
    convertedDocument: { displayKey: string; title: string; statusLabel: string } | null;
    updatedAt: string;
  };
  requirements: Array<{ displayKey: string; title: string; state: string }>;
  gate: BriefGate;
  markdown: string;
};

const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim() || '—';
const linkText = (l: BriefRelatedLink): string => `${l.kind === 'wiki' ? `[[${l.target}]]` : l.url}${l.note ? ` ${l.note}` : ''}`;

/** 把正文标题整体下移，使最浅的标题落在 ### 及以下，保持在导出的「## 正文」之下；围栏代码块内的行不动。 */
function demoteHeadings(markdown: string): string {
  const lines = markdown.split('\n');
  let fence = false;
  const isHeading = (l: string): RegExpMatchArray | null => (fence ? null : l.match(/^(#{1,6})\s/));
  let min = 7;
  for (const l of lines) {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    else min = Math.min(min, isHeading(l)?.[1]!.length ?? 7);
  }
  if (min > 6) return markdown;
  const shift = Math.max(0, 3 - min);
  fence = false;
  return lines
    .map((l) => {
      if (/^\s*(```|~~~)/.test(l)) {
        fence = !fence;
        return l;
      }
      const m = isHeading(l);
      return m ? `${'#'.repeat(Math.min(6, m[1]!.length + shift))}${l.slice(m[1]!.length)}` : l;
    })
    .join('\n');
}

export function briefContextMarkdown(ctx: BriefContext): string {
  const b = ctx.brief;
  const rows: Array<[string, string]> = [
    ['产品', `${b.product.name}（${b.product.key}）`],
    ['状态', b.statusLabel],
    ['版本', b.version],
    ['提出人', b.requester ?? ''],
    ['确认人', b.decider ?? ''],
    ['参与角色', b.participants.join('、')],
    ['作者', b.author ?? ''],
    ['关联文档', b.relatedLinks.map(linkText).join('；')],
    ['已生成的 PRD', b.convertedDocument ? `${b.convertedDocument.displayKey} ${b.convertedDocument.title}（${b.convertedDocument.statusLabel}）` : ''],
    ['更新时间', b.updatedAt],
  ];
  const out = [`# ${b.displayKey} ${b.title}`, '', '| 项 | 内容 |', '| --- | --- |', ...rows.map(([k, v]) => `| ${k} | ${cell(v)} |`), '', '## 关联的需求', ''];
  if (ctx.requirements.length === 0) out.push('还没有关联需求');
  else out.push('| 编号 | 标题 | 状态 |', '| --- | --- | --- |', ...ctx.requirements.map((r) => `| ${r.displayKey} | ${cell(r.title)} | ${cell(r.state)} |`));
  out.push('', `## 写 PRD 前检查（${ctx.gate.passed}/${ctx.gate.total}）`, '');
  for (const i of ctx.gate.items) {
    const tail = i.auto ? `${i.passed ? '' : `：${i.reasons.join('；')}`}（系统已查）` : i.checkedBy ? `（${i.checkedBy.displayName}，${i.checkedAt}）` : '';
    out.push(`- [${i.passed ? 'x' : ' '}] ${i.no}. ${i.label}${tail}`);
  }
  out.push('', '## 正文', '', demoteHeadings(ctx.markdown.trim()));
  return `${out.join('\n')}\n`;
}
