import { diffLines } from 'diff';
import type { CheckState } from '../requirements/labels';
import type { DocumentStatus, ExternalProvider, RevisionSnapshot, TemplateSection } from './constants';

export * from './constants';

// ---------- 编号与状态 ----------

export const DOCUMENT_STATUS_LABELS: Record<DocumentStatus, string> = {
  draft: '草稿',
  review: '评审中',
  approved: '已通过',
  launched: '已上线',
  merged: '已合入',
  discarded: '已废弃',
};

export const documentDisplayKey = (productKey: string, number: number): string => `${productKey}-PRD-${number}`;

export function parseDocumentKey(key: string): { productKey: string; number: number } | null {
  const m = /^([A-Z][A-Z0-9]{1,9})-PRD-(\d{1,9})$/.exec(key.trim());
  return m ? { productKey: m[1]!, number: Number(m[2]) } : null;
}

/** 可流转的目标状态。launched → merged 属于 P2-B（合入），这里没有。 */
export const DOCUMENT_TRANSITIONS: Record<DocumentStatus, DocumentStatus[]> = {
  draft: ['review', 'discarded'],
  review: ['draft', 'approved', 'discarded'],
  approved: ['review', 'launched', 'discarded'],
  launched: [],
  merged: [],
  discarded: ['draft'],
};

export const canTransition = (from: DocumentStatus, to: DocumentStatus): boolean => DOCUMENT_TRANSITIONS[from].includes(to);

/** 「PRD」检查项跟随 PRD 状态的结果（设计 §3）。 */
export function prdCheckState(status: DocumentStatus): CheckState {
  if (status === 'draft' || status === 'review') return 'in_progress';
  if (status === 'discarded') return 'not_needed';
  return 'passed';
}

// ---------- 小节与对比 ----------

export type Section = { key: string; heading: string | null; level: number; path: string[]; markdown: string };

const HEADING = /^(#{1,3})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;

/**
 * 按 1–3 级标题切分（代码块内的 # 不算）。键是从顶层到本节的标题路径，同名小节按出现次序加 #2、#3；
 * 第一个标题之前的内容（不为空时）键为「（开头）」。各节 markdown 用 '\n' 拼回去等于原文。
 */
export function splitSections(markdown: string): Section[] {
  const out: Section[] = [];
  const seen = new Map<string, number>();
  const stack: Array<{ level: number; heading: string }> = [];
  let cur: { heading: string | null; level: number; path: string[]; lines: string[] } = { heading: null, level: 0, path: [], lines: [] };
  let fence = false;
  const flush = () => {
    if (cur.heading === null && cur.lines.join('').trim() === '') return;
    const base = cur.heading === null ? '（开头）' : cur.path.join(' / ');
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    out.push({ key: n === 1 ? base : `${base}#${n}`, heading: cur.heading, level: cur.level, path: cur.path, markdown: cur.lines.join('\n') });
  };
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    if (FENCE.test(line)) fence = !fence;
    const m = fence ? null : HEADING.exec(line);
    if (!m) {
      cur.lines.push(line);
      continue;
    }
    flush();
    const level = m[1]!.length;
    const heading = m[2]!;
    while (stack.length > 0 && stack[stack.length - 1]!.level >= level) stack.pop();
    stack.push({ level, heading });
    cur = { heading, level, path: stack.map((s) => s.heading), lines: [line] };
  }
  flush();
  return out;
}

export type DiffLine = { type: 'add' | 'del' | 'same'; text: string };
export type SectionChange = { key: string; heading: string | null; change: 'added' | 'removed' | 'modified'; lines: DiffLine[] };
export type RevisionDiff = { title: { old: string; new: string } | null; sections: SectionChange[] };

/** 末尾补换行：jsdiff 会把「没有结尾换行的最后一行」与同样内容带换行的行当作不同的行。 */
const withEol = (s: string): string => (s === '' || s.endsWith('\n') ? s : `${s}\n`);

function lineDiff(a: string, b: string): DiffLine[] {
  const out: DiffLine[] = [];
  for (const part of diffLines(withEol(a), withEol(b))) {
    const type: DiffLine['type'] = part.added ? 'add' : part.removed ? 'del' : 'same';
    for (const text of part.value.replace(/\n$/, '').split('\n')) out.push({ type, text });
  }
  return out;
}

/** 两版正文按小节配对比较：先按新版顺序列出修改与新增，再按旧版顺序列出删除。 */
export function diffSections(oldMd: string, newMd: string): SectionChange[] {
  const before = splitSections(oldMd);
  const after = splitSections(newMd);
  const oldByKey = new Map(before.map((s) => [s.key, s]));
  const newKeys = new Set(after.map((s) => s.key));
  const out: SectionChange[] = [];
  for (const s of after) {
    const prev = oldByKey.get(s.key);
    if (!prev) out.push({ key: s.key, heading: s.heading, change: 'added', lines: lineDiff('', s.markdown) });
    else if (prev.markdown.trim() !== s.markdown.trim()) out.push({ key: s.key, heading: s.heading, change: 'modified', lines: lineDiff(prev.markdown.trim(), s.markdown.trim()) });
  }
  for (const s of before) if (!newKeys.has(s.key)) out.push({ key: s.key, heading: s.heading, change: 'removed', lines: lineDiff(s.markdown, '') });
  return out;
}

export function diffRevisionSnapshots(a: RevisionSnapshot, b: RevisionSnapshot): RevisionDiff {
  return { title: a.title === b.title ? null : { old: a.title, new: b.title }, sections: diffSections(a.markdown, b.markdown) };
}

// ---------- 纯文本与文本引用定位 ----------

const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

/** 正文的可见文字：去掉代码块围栏、表格分隔行、图片、链接网址、HTML 标签、标题与引用符号、列表符号、强调符号。 */
export function plainText(markdown: string): string {
  return markdown
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((l) => !FENCE.test(l) && !TABLE_RULE.test(l))
    .map((l) => l.replace(/^\s*>\s?/, '').replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '').replace(/^\s{0,3}#{1,6}\s+/, ''))
    .join('\n')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[*_~`]+/g, '');
}

/** 比较用的形式：去掉全部空白与不影响阅读的 Markdown 符号。页面上选中的文字与正文按同一规则处理。 */
export const squash = (s: string): string => s.replace(/[\s*_~`|\\]/g, '');

function commonSuffix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

function commonPrefix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/**
 * W3C TextQuoteSelector 的精确匹配：在比较形式（squash 之后）的 text 里找 quote 的全部出现，
 * 按「与 prefix 的公共后缀 + 与 suffix 的公共前缀」打分，返回分数最高（同分取最先出现）的起点与分数。找不到返回 null。
 * 服务端（按小节的纯文本）与编辑器（按文本节点）共用。
 */
export function bestQuoteMatch(text: string, a: { quote: string; prefix: string; suffix: string }): { at: number; score: number } | null {
  const q = squash(a.quote);
  if (!q) return null;
  const pre = squash(a.prefix);
  const suf = squash(a.suffix);
  let best: { at: number; score: number } | null = null;
  for (let i = text.indexOf(q); i !== -1; i = text.indexOf(q, i + 1)) {
    const score = commonSuffix(text.slice(0, i), pre) + commonPrefix(text.slice(i + q.length), suf);
    if (!best || score > best.score) best = { at: i, score };
  }
  return best;
}

/** 在每个小节的纯文本里按 bestQuoteMatch 找 quote，取分数最高的小节。找不到返回 null（评论标为已失效）。 */
export function locateQuote(markdown: string, a: { quote: string; prefix: string; suffix: string }): { sectionHeading: string | null } | null {
  let best: { score: number; heading: string | null } | null = null;
  for (const s of splitSections(markdown)) {
    const m = bestQuoteMatch(squash(plainText(s.markdown)), a);
    if (m && (!best || m.score > best.score)) best = { score: m.score, heading: s.heading };
  }
  return best ? { sectionHeading: best.heading } : null;
}

// ---------- 外部网址 ----------

const PROVIDER_HOSTS: Array<[ExternalProvider, RegExp]> = [
  ['wecom', /^(doc|drive)\.weixin\.qq\.com$/],
  ['tencent_docs', /^docs\.qq\.com$/],
  ['feishu', /(^|\.)(feishu\.cn|larksuite\.com|larkoffice\.com)$/],
  ['notion', /(^|\.)notion\.(so|site)$/],
  ['yuque', /(^|\.)yuque\.com$/],
  ['google_docs', /^docs\.google\.com$/],
];

export function detectProvider(host: string): ExternalProvider {
  const h = host.toLowerCase();
  return PROVIDER_HOSTS.find(([, re]) => re.test(h))?.[0] ?? 'other';
}

/** 不影响指向哪份文档的参数：追踪参数与企业微信的分享码。 */
const DROP_PARAMS = new Set(['spm', 'from', 'share_source', 'scode']);

/**
 * 外部 PRD 网址：url 是去掉首尾空白的原文（保留分享码，打开时仍可用）；key 用于同一产品内去重
 * （https、主机名小写、去默认端口、去片段与末尾斜杠、去追踪参数，其余参数按名排序）。不是网址返回 null。
 */
export function normalizeExternalUrl(raw: string): { url: string; key: string; provider: ExternalProvider } | null {
  const url = raw.trim();
  if (!/^https?:\/\/\S+$/i.test(url)) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const provider = detectProvider(host);
  const params = [...u.searchParams.entries()]
    .filter(([k]) => {
      const l = k.toLowerCase();
      return !l.startsWith('utm_') && !DROP_PARAMS.has(l) && !(l === 't' && host.endsWith('figma.com'));
    })
    .sort(([a, x], [b, y]) => a.localeCompare(b) || x.localeCompare(y));
  const port = u.port && u.port !== '80' && u.port !== '443' ? `:${u.port}` : '';
  const query = params.length > 0 ? `?${new URLSearchParams(params).toString()}` : '';
  return { url, key: `https://${host}${port}${u.pathname.replace(/\/+$/, '')}${query}`, provider };
}

// ---------- 模板 ----------

export function fillTemplate(body: string, vars: { date: string; author: string }): string {
  return body.replaceAll('{{date}}', vars.date).replaceAll('{{author}}', vars.author);
}

/** 小节标题的比较形式：去掉开头的数字编号与全部空白。必填小节、评论所在小节与 [[PRD#小节]] 共用。 */
export const normalizeHeading = (s: string): string => s.replace(/^[\d.、\s]+/, '').replace(/\s+/g, '');

/**
 * 缺少或未填写的必填小节（按模板顺序返回模板里的标题）。标题去掉开头的数字编号与空白后相等即为同一小节；
 * 小节及其下级小节里，除了与模板正文完全相同的行，还有文字才算已填写。
 */
export function missingRequiredSections(markdown: string, template: { body: string; sections: TemplateSection[] }): string[] {
  const sections = splitSections(markdown);
  const templateLines = new Set(
    template.body
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !HEADING.test(l)),
  );
  const filled = (s: Section) =>
    s.markdown
      .split('\n')
      .slice(s.heading === null ? 0 : 1)
      .some((l) => {
        const t = l.trim();
        return t !== '' && !templateLines.has(t) && squash(plainText(t)) !== '';
      });
  return template.sections
    .filter((t) => t.required)
    .filter((t) => {
      const i = sections.findIndex((s) => s.heading !== null && normalizeHeading(s.heading) === normalizeHeading(t.heading));
      if (i === -1) return true;
      const own = [sections[i]!];
      for (let j = i + 1; j < sections.length && sections[j]!.level > sections[i]!.level; j++) own.push(sections[j]!);
      return !own.some(filled);
    })
    .map((t) => t.heading);
}
