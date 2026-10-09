/**
 * [[双链]] 的语法：解析、分类、规范写法、上下文与编辑器文本块定位。
 * 浏览器与服务端共用（@flower/core/links），不导入其他模块。
 */

export const LINK_SOURCE_TYPES = ['requirement', 'document', 'comment'] as const;
export type LinkSourceType = (typeof LINK_SOURCE_TYPES)[number];
export const LINK_TARGET_TYPES = ['requirement', 'document', 'task', 'iteration', 'structure_node'] as const;
export type LinkTargetType = (typeof LINK_TARGET_TYPES)[number];
export const LINK_ORIGINS = ['wikilink', 'system', 'manual'] as const;
export type LinkOrigin = (typeof LINK_ORIGINS)[number];

/** 引用处上下文的最大长度（字符）。 */
export const CONTEXT_MAX = 120;

export type WikiTarget =
  | { kind: 'requirement'; productKey: string; number: number }
  | { kind: 'document'; productKey: string; number: number; section: string | null }
  | { kind: 'task'; productKey: string; number: number }
  | { kind: 'iteration'; productKey: string | null; name: string }
  /** 结构树节点路径，或只有一段的旧编号；首段是否为产品前缀见 canonicalText。 */
  | { kind: 'path'; segments: string[] };

export type WikiLink = { raw: string; target: string; label: string | null; start: number; end: number };
export type WikiSegment = { kind: 'text'; text: string } | { kind: 'link'; link: WikiLink };
/** 编辑器文本块里的一段文字：pos 为首字符在文档中的位置，code 为带代码样式。 */
export type TextPart = { text: string; pos: number; code: boolean };

const KEY = '([A-Za-z][A-Za-z0-9]{1,9})';
const DOC_RE = new RegExp(`^${KEY}-PRD-(\\d{1,9})(?:#(.*))?$`, 'i');
const TASK_RE = new RegExp(`^${KEY}-T-(\\d{1,9})$`, 'i');
const REQ_RE = new RegExp(`^${KEY}-(\\d{1,9})$`);
const ITER_RE = new RegExp(`^(?:${KEY}\\/)?迭代[:：](.+)$`);
/** 路径首段与产品编号前缀同形时视为产品前缀。 */
const PREFIX_RE = /^[A-Z][A-Z0-9]{1,9}$/;
const LINK_RE = /\[\[([^[\]\n]+?)\]\]/g;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const SENTENCE_END = /[。！？!?；;\n]/;

/** 围栏代码块（不闭合时到文末）与同一行内成对反引号所占的区间 [start, end)。 */
function codeRanges(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const plain: Array<[number, string]> = [];
  let pos = 0;
  let fence: { start: number; char: string } | null = null;
  for (const line of text.split('\n')) {
    const m = FENCE_RE.exec(line);
    if (fence) {
      if (m && m[1]![0] === fence.char) {
        out.push([fence.start, pos + line.length]);
        fence = null;
      }
    } else if (m) {
      fence = { start: pos, char: m[1]![0]! };
    } else {
      plain.push([pos, line]);
    }
    pos += line.length + 1;
  }
  if (fence) out.push([fence.start, text.length]);
  for (const [start, line] of plain) {
    for (const m of line.matchAll(/(`+)[^`]+?\1(?!`)/g)) out.push([start + m.index, start + m.index + m[0].length]);
  }
  return out;
}

export function parseWikilinks(text: string): WikiLink[] {
  const code = codeRanges(text);
  const inCode = (i: number) => code.some(([s, e]) => i >= s && i < e);
  const out: WikiLink[] = [];
  for (const m of text.matchAll(LINK_RE)) {
    const start = m.index;
    if (text[start - 1] === '\\' || inCode(start)) continue;
    const inner = m[1]!;
    const bar = inner.indexOf('|');
    const target = (bar === -1 ? inner : inner.slice(0, bar)).trim();
    const label = bar === -1 ? null : inner.slice(bar + 1).trim() || null;
    if (!target) continue;
    out.push({ raw: m[0], target, label, start, end: start + m[0].length });
  }
  return out;
}

export function classifyTarget(target: string): WikiTarget {
  const t = target.trim();
  let m = DOC_RE.exec(t);
  if (m) return { kind: 'document', productKey: m[1]!.toUpperCase(), number: Number(m[2]), section: m[3]?.trim() || null };
  m = TASK_RE.exec(t);
  if (m) return { kind: 'task', productKey: m[1]!.toUpperCase(), number: Number(m[2]) };
  m = REQ_RE.exec(t);
  if (m) return { kind: 'requirement', productKey: m[1]!.toUpperCase(), number: Number(m[2]) };
  m = ITER_RE.exec(t);
  if (m && m[2]!.trim()) return { kind: 'iteration', productKey: m[1]?.toUpperCase() ?? null, name: m[2]!.trim() };
  return {
    kind: 'path',
    segments: t
      .split('/')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

export const taskDisplayKey = (productKey: string, number: number): string => `${productKey}-T-${number}`;

export function parseTaskKey(key: string): { productKey: string; number: number } | null {
  const m = TASK_RE.exec(key.trim());
  return m ? { productKey: m[1]!.toUpperCase(), number: Number(m[2]) } : null;
}

/** 规范写法（存为 entity_links.target_text）：编号大写，迭代与节点带上产品前缀，小节标题保留原样。 */
export function canonicalText(t: WikiTarget, sourceProductKey: string): string {
  const own = sourceProductKey.toUpperCase();
  switch (t.kind) {
    case 'requirement':
      return `${t.productKey}-${t.number}`;
    case 'document':
      return `${t.productKey}-PRD-${t.number}${t.section ? `#${t.section}` : ''}`;
    case 'task':
      return taskDisplayKey(t.productKey, t.number);
    case 'iteration':
      return `${t.productKey ?? own}/迭代:${t.name}`;
    case 'path': {
      const prefixed = t.segments.length >= 2 && PREFIX_RE.test(t.segments[0]!);
      return prefixed ? t.segments.join('/') : [own, ...t.segments].join('/');
    }
  }
}

export const canonicalWikiText = (target: string, sourceProductKey: string): string => canonicalText(classifyTarget(target), sourceProductKey);

/** 引用处所在的一句（带句末标点）；超过 CONTEXT_MAX 时以链接为中心截取，截掉的一端加「…」。 */
export function linkContext(text: string, start: number, end: number): string {
  let a = start;
  while (a > 0 && !SENTENCE_END.test(text[a - 1]!)) a--;
  let b = end;
  while (b < text.length && !SENTENCE_END.test(text[b]!)) b++;
  if (b < text.length && text[b] !== '\n') b++;
  const raw = text.slice(a, b);
  const lead = raw.length - raw.trimStart().length;
  const s = raw.trim();
  if (s.length <= CONTEXT_MAX) return s;
  const rel = start - a - lead;
  const from = Math.max(0, Math.min(rel - 30, s.length - CONTEXT_MAX));
  return `${from > 0 ? '…' : ''}${s.slice(from, from + CONTEXT_MAX)}${from + CONTEXT_MAX < s.length ? '…' : ''}`;
}

/** 显示用：把文字拆成普通文字与链接两种片段。 */
export function splitWikiText(text: string): WikiSegment[] {
  const out: WikiSegment[] = [];
  let at = 0;
  for (const link of parseWikilinks(text)) {
    if (link.start > at) out.push({ kind: 'text', text: text.slice(at, link.start) });
    out.push({ kind: 'link', link });
    at = link.end;
  }
  if (at < text.length) out.push({ kind: 'text', text: text.slice(at) });
  return out;
}

/** 编辑器一个文本块里 [[ ]] 的位置 [from, to)；parts 是块内依次出现的文本节点，带代码样式的部分按空白处理。 */
export function wikiRangesInBlock(parts: TextPart[]): Array<{ from: number; to: number; target: string }> {
  let text = '';
  const posAt: number[] = [];
  for (const p of parts) {
    for (let i = 0; i < p.text.length; i++) posAt.push(p.pos + i);
    text += p.code ? ' '.repeat(p.text.length) : p.text;
  }
  return parseWikilinks(text).map((l) => ({ from: posAt[l.start]!, to: posAt[l.end - 1]! + 1, target: l.target }));
}
