import { bestQuoteMatch, CHANGE_DOCUMENT_STATUSES, type DocumentStatus, type ExternalProvider, normalizeHeading, splitSections, squash, type TemplateSection } from '@flower/core/markdown';
import { nodeOptions } from '@/features/structure/model';
import type { AffectedChangeType, DocumentComment, MergeStatus, StructureNode } from '@/lib/types';

export const DOCUMENT_STATUS_COLOR: Record<DocumentStatus, string> = {
  draft: '#8a9199',
  review: '#2f6fd6',
  approved: '#1f6f54',
  launched: '#1e8a5a',
  merged: '#0f766e',
  discarded: '#5c6570',
  active: '#1e8a5a',
  archived: '#8a9199',
  discussing: '#2f6fd6',
  ready: '#1f6f54',
  converted: '#0f766e',
};

export const PROVIDER_LABEL: Record<ExternalProvider, string> = {
  wecom: '企业微信文档',
  feishu: '飞书文档',
  tencent_docs: '腾讯文档',
  notion: 'Notion',
  yuque: '语雀',
  google_docs: 'Google 文档',
  other: '外部链接',
};

export function sourceLabel(d: { source: 'native' | 'external'; externalProvider: ExternalProvider | null }): string {
  return d.source === 'native' ? 'Flower 文档' : PROVIDER_LABEL[d.externalProvider ?? 'other'];
}

export const documentHref = (org: string, displayKey: string): string => `/${org}/documents/${displayKey}`;

export type DocumentView = 'change' | 'modules';

/** 文档页的页签只由地址栏决定：?view=modules 为「模块文档」，否则为「变更 PRD」。 */
export const documentView = (sp: URLSearchParams): DocumentView => (sp.get('view') === 'modules' ? 'modules' : 'change');

/** 「模块文档」页签的地址；带 nodeId 时定位到这个模块。 */
export function moduleDocsHref(org: string, productKey: string, nodeId?: string | null): string {
  const p = new URLSearchParams({ product: productKey, view: 'modules' });
  if (nodeId) p.set('node', nodeId);
  return `/${org}/documents?${p.toString()}`;
}

export type DocumentListFilter = { product: string; status: DocumentStatus | ''; owner: string; source: 'native' | 'external' | ''; q: string };

export function parseDocumentFilter(sp: URLSearchParams): DocumentListFilter {
  const status = sp.get('status') ?? '';
  const source = sp.get('source') ?? '';
  return {
    product: sp.get('product') ?? '',
    status: (CHANGE_DOCUMENT_STATUSES as readonly string[]).includes(status) ? (status as DocumentStatus) : '',
    owner: sp.get('owner') ?? '',
    source: source === 'native' || source === 'external' ? source : '',
    q: sp.get('q') ?? '',
  };
}

function toParams(f: DocumentListFilter, keys: Array<keyof DocumentListFilter>): string {
  const p = new URLSearchParams();
  for (const k of keys) if (f[k]) p.set(k, f[k]);
  return p.toString();
}

/** 地址栏：带上产品。 */
export const documentFilterToSearch = (f: DocumentListFilter): string => toParams(f, ['product', 'status', 'owner', 'source', 'q']);
/** 接口查询串：产品在路径里，不重复。 */
export const documentFilterToApiQuery = (f: DocumentListFilter): string => toParams(f, ['status', 'owner', 'source', 'q']);

/** 「关联需求」输入框：逗号、顿号、空白分隔的需求编号，转大写、去重。 */
export function parseRequirementKeys(input: string): string[] {
  const keys = input
    .split(/[\s,，、;；]+/)
    .map((s) => s.trim().toUpperCase())
    .filter((s) => /^[A-Z][A-Z0-9]{1,9}-\d{1,9}$/.test(s));
  return [...new Set(keys)];
}

export type SaveState = 'saved' | 'dirty' | 'saving';

export function saveStateLabel(state: SaveState, editable: boolean): string {
  if (!editable) return '只读';
  return state === 'saving' ? '保存中…' : state === 'dirty' ? '未保存' : '已保存';
}

const CONTEXT_CHARS = 32;

/** 划词评论的前后文（W3C TextQuoteSelector 的 prefix / suffix），各取 32 个字符。 */
export function clipContext(before: string, after: string): { prefix: string; suffix: string } {
  return { prefix: before.slice(-CONTEXT_CHARS), suffix: after.slice(0, CONTEXT_CHARS) };
}

export type Thread = { comment: DocumentComment; replies: DocumentComment[] };

/** 评论按顶层分组（保持时间顺序），回复挂在所属评论下；上级不存在的回复当作顶层显示。 */
export function groupThreads(comments: DocumentComment[]): Thread[] {
  const ids = new Set(comments.map((c) => c.id));
  const threads = comments.filter((c) => !c.parentId || !ids.has(c.parentId)).map((comment) => ({ comment, replies: [] as DocumentComment[] }));
  const byId = new Map(threads.map((t) => [t.comment.id, t]));
  for (const c of comments) if (c.parentId && byId.has(c.parentId)) byId.get(c.parentId)!.replies.push(c);
  return threads;
}

export const SECTION_CHANGE_LABEL = { added: '新增', removed: '删除', modified: '修改' } as const;
export const CHANGE_TYPE_LABEL: Record<AffectedChangeType, string> = { added: '新增', modified: '修改', removed: '删除' };
export const MERGE_STATUS_LABEL: Record<MergeStatus, string> = { pending: '待合入', applied: '已应用', skipped: '已跳过' };
export const ANCHOR_STATE_LABEL = { stale: '已失效', unanchored: '未定位' } as const;

export const IMPORT_LIMITS = { markdownBytes: 2 * 1024 * 1024, docxBytes: 20 * 1024 * 1024 } as const;

const DATA_IMAGE = /!\[[^\]]*\]\((data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+))\)/g;
const REMOTE_IMAGE = /!\[[^\]]*\]\(https?:\/\/[^)\s]+\)/g;

/** 正文里可以转存为附件的 data: 图片（PNG、JPEG、GIF、WebP），按内容去重。 */
export function findDataImages(markdown: string): Array<{ src: string; mime: string; base64: string }> {
  const out = new Map<string, { src: string; mime: string; base64: string }>();
  for (const m of markdown.matchAll(DATA_IMAGE)) if (!out.has(m[1]!)) out.set(m[1]!, { src: m[1]!, mime: m[2]!, base64: m[3]! });
  return [...out.values()];
}

export function replaceImageSources(markdown: string, map: Map<string, string>): string {
  return markdown.replace(/(!\[[^\]]*\]\()([^)\s]+)(\))/g, (all, open: string, src: string, close: string) => (map.has(src) ? `${open}${map.get(src)}${close}` : all));
}

/** 指向外部网址的图片：不抓取（需要外部平台登录），保留原链接。 */
export const countRemoteImages = (markdown: string): number => [...markdown.matchAll(REMOTE_IMAGE)].length;

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function importSummary(markdown: string): { chars: number; sections: number; images: number; remoteImages: number } {
  return {
    chars: markdown.length,
    sections: splitSections(markdown).filter((s) => s.heading !== null).length,
    images: findDataImages(markdown).length,
    remoteImages: countRemoteImages(markdown),
  };
}

/** 模板编辑时「从正文提取小节」：正文里的二级标题，默认选填。 */
export function sectionsFromBody(body: string): TemplateSection[] {
  return splitSections(body)
    .filter((s) => s.level === 2 && s.heading)
    .map((s) => ({ heading: s.heading!, required: false }));
}

/** [[PRD#小节]] 跳转：按归一化标题（去编号与空白）找第一个匹配的标题，没有时为 -1。 */
export function findSectionIndex(headings: string[], section: string): number {
  const want = normalizeHeading(section);
  return headings.findIndex((h) => normalizeHeading(h) === want);
}

export type TextSegment = { text: string; pos: number };
export type EditorAnchor = { id: string; quote: string; prefix: string; suffix: string };

/**
 * 划词评论的原文在编辑器文档中的位置 [from, to)：文本节点按 squash 的规则去掉空白与 Markdown 符号后拼起来，
 * 用与服务端 locateQuote 相同的 bestQuoteMatch 定位，再换回文档位置。segments 是文档里依次出现的文本节点。找不到返回 null。
 */
export function locateAnchorRange(segments: TextSegment[], a: { quote: string; prefix: string; suffix: string }): { from: number; to: number } | null {
  let text = '';
  const posAt: number[] = [];
  for (const s of segments) {
    for (let i = 0; i < s.text.length; i++) {
      const ch = squash(s.text[i]!);
      if (!ch) continue;
      text += ch;
      posAt.push(s.pos + i);
    }
  }
  const m = bestQuoteMatch(text, a);
  return m ? { from: posAt[m.at]!, to: posAt[m.at + squash(a.quote).length - 1]! + 1 } : null;
}

/** 编辑器里要高亮的评论：顶层、定位正常（已失效与未定位的不算）、未解决的划词评论。 */
export function editorAnchors(comments: DocumentComment[]): EditorAnchor[] {
  return comments
    .filter((c) => !c.parentId && c.anchor && c.anchorState === 'ok' && !c.resolvedAt)
    .map((c) => ({ id: c.id, quote: c.anchor!.quote, prefix: c.anchor!.prefix, suffix: c.anchor!.suffix }));
}

export type NodeOption = { id: string; path: string };

function pathOf(nodes: StructureNode[]): (id: string) => string {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return (id) => {
    const names: string[] = [];
    for (let cur = byId.get(id); cur; cur = cur.parentId ? byId.get(cur.parentId) : undefined) names.unshift(cur.name);
    return names.join('/');
  };
}

/** 某一层没停用（本身与上级都没停用）的节点，按树的顺序，带名称路径。 */
function activeAt(nodes: StructureNode[], depth: number): NodeOption[] {
  const path = pathOf(nodes);
  return nodeOptions(nodes, null)
    .filter((n) => n.depth === depth)
    .map((n) => ({ id: n.id, path: path(n.id) }));
}

/** 声明影响时可选的功能点：没停用、还没声明过，名称路径包含查询（不区分大小写），按树的顺序最多 20 个。 */
export function featureOptions(nodes: StructureNode[], q: string, exclude: Set<string>): NodeOption[] {
  const want = q.trim().toLowerCase();
  return activeAt(nodes, 3)
    .filter((o) => !exclude.has(o.id) && (!want || o.path.toLowerCase().includes(want)))
    .slice(0, 20);
}

/** 当场新建功能点时可选的模块。 */
export const moduleOptions = (nodes: StructureNode[]): NodeOption[] => activeAt(nodes, 2);

/** 当场新建模块时可选的业务域。 */
export const domainOptions = (nodes: StructureNode[]): NodeOption[] => activeAt(nodes, 1);
