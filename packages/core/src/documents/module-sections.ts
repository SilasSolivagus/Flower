import { normalizeHeading, splitSections } from './markdown';

/**
 * 模块文档按功能点分节：第一个二级标题之前为概述，每个功能点一个二级标题（标题文字为功能点名称），
 * 三级及以下标题属于所在小节。小节按功能点名称归一化（与评论锚点相同：去开头编号与空白）定位，同名取第一个。
 */

const H2 = /^##\s+(.*?)\s*#*\s*$/;
const TOP_HEADING = /^#{1,2}\s/;
const ANY_HEADING = /^(#{1,6})(\s.*)$/;
const FENCE = /^\s*(```|~~~)/;

export type FeatureSection = { heading: string; start: number; end: number };

const toLines = (markdown: string): string[] => markdown.replace(/\r\n?/g, '\n').split('\n');

/** 去掉首尾的空白行。 */
function trimBlank(lines: string[]): string[] {
  let a = 0;
  let b = lines.length;
  while (a < b && lines[a]!.trim() === '') a++;
  while (b > a && lines[b - 1]!.trim() === '') b--;
  return lines.slice(a, b);
}

/** 二级标题小节在行数组中的范围 [start, end)，start 为标题行；围栏代码块里的 # 不算。 */
export function featureSections(lines: string[]): FeatureSection[] {
  const out: FeatureSection[] = [];
  let fence = false;
  lines.forEach((line, i) => {
    if (FENCE.test(line)) fence = !fence;
    const m = fence ? null : H2.exec(line);
    if (!m) return;
    if (out.length > 0) out[out.length - 1]!.end = i;
    out.push({ heading: m[1]!, start: i, end: lines.length });
  });
  return out;
}

const findFeature = (sections: FeatureSection[], name: string): FeatureSection | undefined =>
  sections.find((s) => normalizeHeading(s.heading) === normalizeHeading(name));

/** 功能点小节的正文（不含标题行，去掉首尾空行）；找不到返回 null。 */
export function featureSectionBody(markdown: string, name: string): string | null {
  const lines = toLines(markdown);
  const hit = findFeature(featureSections(lines), name);
  return hit ? trimBlank(lines.slice(hit.start + 1, hit.end)).join('\n') : null;
}

/** 一个小节的行：标题行、空行、正文、空行；正文为空时为标题行、空行。 */
function sectionLines(headingLine: string, body: string): string[] {
  const bodyLines = trimBlank(toLines(body));
  return bodyLines.length > 0 ? [headingLine, '', ...bodyLines, ''] : [headingLine, ''];
}

/**
 * 合入一个功能点。已有小节：保留原标题行，替换正文。没有小节：按 order（该模块下功能点在结构树中的顺序）
 * 插到排在它后面的第一个已有小节之前，后面都没有（或它不在 order 里）时追加到文末。remove：删除整个小节，找不到时原样返回。
 */
export function applyFeatureSection(markdown: string, input: { name: string; body: string; order: string[]; remove?: boolean }): string {
  const lines = toLines(markdown);
  const sections = featureSections(lines);
  const hit = findFeature(sections, input.name);
  if (input.remove) {
    if (!hit) return markdown;
    lines.splice(hit.start, hit.end - hit.start);
    return lines.join('\n');
  }
  if (hit) {
    lines.splice(hit.start, hit.end - hit.start, ...sectionLines(lines[hit.start]!, input.body));
    return lines.join('\n');
  }
  const fresh = sectionLines(`## ${input.name}`, input.body);
  if (markdown.trim() === '') return fresh.join('\n');
  const want = normalizeHeading(input.name);
  const at = input.order.findIndex((n) => normalizeHeading(n) === want);
  const later = new Set(at === -1 ? [] : input.order.slice(at + 1).map(normalizeHeading));
  const next = sections.find((s) => later.has(normalizeHeading(s.heading)));
  const pos = next ? next.start : lines.length;
  // 与上一段之间空一行
  const gap = pos > 0 && lines[pos - 1]!.trim() !== '' ? [''] : [];
  lines.splice(pos, 0, ...gap, ...fresh);
  return lines.join('\n');
}

/** 功能点改名：把小节标题改为新名称，保留原标题开头的编号；找不到返回 null。 */
export function renameFeatureHeading(markdown: string, oldName: string, newName: string): string | null {
  const lines = toLines(markdown);
  const hit = findFeature(featureSections(lines), oldName);
  if (!hit) return null;
  const number = /^[\d.、\s]+/.exec(hit.heading)?.[0] ?? '';
  lines[hit.start] = `## ${number}${newName}`;
  return lines.join('\n');
}

/** 合入内容里是否有一级或二级标题（围栏代码块内的不算）。 */
export function hasTopHeadings(body: string): boolean {
  let fence = false;
  for (const line of toLines(body)) {
    if (FENCE.test(line)) {
      fence = !fence;
      continue;
    }
    if (!fence && TOP_HEADING.test(line)) return true;
  }
  return false;
}

/** 变更 PRD 可选的来源小节：splitSections 的键（标题路径），只含有标题的小节。 */
export function prdSectionKeys(markdown: string): string[] {
  return splitSections(markdown)
    .filter((s) => s.heading !== null)
    .map((s) => s.key);
}

/**
 * 来源小节的内容：该小节正文（不含它自己的标题行）加上它的全部下级小节。标题级别整体下移，
 * 使来源的直接下级成为三级标题（最多六级，围栏代码块内不改），避免在模块文档里产生新的二级标题。找不到返回 null。
 */
export function sourceSectionText(markdown: string, key: string): string | null {
  const sections = splitSections(markdown);
  const i = sections.findIndex((s) => s.heading !== null && s.key === key);
  if (i === -1) return null;
  const own = sections[i]!;
  const lines = own.markdown.split('\n').slice(1);
  for (let j = i + 1; j < sections.length && sections[j]!.level > own.level; j++) lines.push(...sections[j]!.markdown.split('\n'));
  const shift = Math.max(0, 2 - own.level);
  let fence = false;
  const shifted = lines.map((line) => {
    if (FENCE.test(line)) {
      fence = !fence;
      return line;
    }
    if (fence || shift === 0) return line;
    const m = ANY_HEADING.exec(line);
    return m ? `${'#'.repeat(Math.min(6, m[1]!.length + shift))}${m[2]}` : line;
  });
  return trimBlank(shifted).join('\n');
}
