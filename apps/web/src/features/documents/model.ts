import { DOCUMENT_STATUSES, type DocumentStatus, type ExternalProvider } from '@flower/core/markdown';

export const DOCUMENT_STATUS_COLOR: Record<DocumentStatus, string> = {
  draft: '#8a9199',
  review: '#2f6fd6',
  approved: '#1f6f54',
  launched: '#1e8a5a',
  merged: '#0f766e',
  discarded: '#5c6570',
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

export type DocumentListFilter = { product: string; status: DocumentStatus | ''; owner: string; source: 'native' | 'external' | ''; q: string };

export function parseDocumentFilter(sp: URLSearchParams): DocumentListFilter {
  const status = sp.get('status') ?? '';
  const source = sp.get('source') ?? '';
  return {
    product: sp.get('product') ?? '',
    status: (DOCUMENT_STATUSES as readonly string[]).includes(status) ? (status as DocumentStatus) : '',
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
