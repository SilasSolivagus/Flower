import type { ProgressSubjectType, TrackingItem, TrackingList } from '@/lib/types';

export const TRACKING_TABS = ['all', 'aging', 'board', 'owners'] as const;
export type TrackingTab = (typeof TRACKING_TABS)[number];
export const TAB_LABELS: Record<TrackingTab, string> = { all: '全部在手', aging: '任务老化', board: '按阶段看板', owners: '按产品经理' };

export const WORK_ITEM_STATUS_LABELS = { active: '进行中', done: '已完成', canceled: '已取消' } as const;

export type TrackingFilter = { tab: TrackingTab; product: string | null; owner: string | null; type: string | null; paused: boolean; blocked: boolean; done: boolean };
export const DEFAULT_FILTER: TrackingFilter = { tab: 'all', product: null, owner: null, type: null, paused: false, blocked: false, done: false };

/** 地址栏 → 筛选。不认识的页签当作「全部在手」；产品、负责人、类型原样带给接口（格式不对由接口返回 400）。 */
export function filterFromParams(params: URLSearchParams): TrackingFilter {
  const tab = params.get('tab') ?? '';
  return {
    tab: (TRACKING_TABS as readonly string[]).includes(tab) ? (tab as TrackingTab) : 'all',
    product: params.get('product') || null,
    owner: params.get('owner') || null,
    type: params.get('type') || null,
    paused: params.get('paused') === '1',
    blocked: params.get('blocked') === '1',
    done: params.get('done') === '1',
  };
}

/** 接口查询串（不含页签）。 */
export function filterQuery(f: TrackingFilter): string {
  const p = new URLSearchParams();
  if (f.product) p.set('product', f.product);
  if (f.owner) p.set('owner', f.owner);
  if (f.type) p.set('type', f.type);
  if (f.paused) p.set('paused', '1');
  if (f.blocked) p.set('blocked', '1');
  if (f.done) p.set('done', '1');
  return p.toString();
}

/** 页面地址：页签为「全部在手」时不写 tab。 */
export function trackingHref(org: string, f: TrackingFilter): string {
  const p = new URLSearchParams(filterQuery(f));
  if (f.tab !== 'all') p.set('tab', f.tab);
  const q = p.toString();
  return `/${org}/tracking${q ? `?${q}` : ''}`;
}

/** 是否有筛选（页签不算）。 */
export const hasFilter = (f: TrackingFilter): boolean => !!(f.product || f.owner || f.type || f.paused || f.blocked || f.done);

/** 空筛时点明当前条件。候选里找不到的 id 用占位名，方便和筛选条对上。 */
export function trackingFilterSummary(
  f: TrackingFilter,
  list: { products: Array<{ id: string; name: string }>; owners: Array<{ id: string; displayName: string }>; typeOptions: Array<{ id: string; label: string }> },
): string {
  const bits: string[] = [];
  if (f.product) bits.push(`产品：${list.products.find((p) => p.id === f.product)?.name ?? '看不到的产品'}`);
  if (f.owner) bits.push(`负责人：${list.owners.find((o) => o.id === f.owner)?.displayName ?? '已不在列表中的负责人'}`);
  if (f.type) bits.push(`类型：${list.typeOptions.find((t) => t.id === f.type)?.label ?? '已不存在的类型'}`);
  if (f.paused) bits.push('只看暂停');
  if (f.blocked) bits.push('只看有阻塞');
  if (f.done) bits.push('含最近 30 天完成');
  return bits.length === 0 ? '' : `当前筛选：${bits.join('，')}`;
}

export const itemHref = (org: string, i: Pick<TrackingItem, 'kind' | 'displayKey'>): string =>
  `/${org}/${i.kind === 'requirement' ? 'requirements' : 'work-items'}/${i.displayKey}`;

/** 写进展小窗的对象。canEditDate：能否顺手改预计日期（需求为预计上线，工作项为预计完成）。 */
export type ProgressTarget = { type: ProgressSubjectType; id: string; displayKey: string; title: string; expectedDate: string | null; canEditDate: boolean };

const pad2 = (n: number) => String(n).padStart(2, '0');

/** 本地日历日 YYYY-MM-DD，用来和预计日比较，不走 UTC。 */
export function localDateIso(now: Date): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

export type ExpectedDateView = { text: string; overdue: boolean };

/** 空日期写「未设置」。未完成且日期早于今天则为逾期。日期是 YYYY-MM-DD，按字符串比较。 */
export function expectedDateView(expectedDate: string | null | undefined, opts: { done: boolean; today: string }): ExpectedDateView {
  if (!expectedDate) return { text: '未设置', overdue: false };
  return { text: expectedDate, overdue: !opts.done && expectedDate < opts.today };
}

export const targetOf = (i: TrackingItem): ProgressTarget => ({
  type: i.kind,
  id: i.id,
  displayKey: i.displayKey,
  title: i.title,
  expectedDate: i.expectedDate,
  canEditDate: i.canEditDate,
});

const byKey = (a: TrackingItem, b: TrackingItem) => a.displayKey.localeCompare(b.displayKey, 'zh-CN', { numeric: true });

/** 任务老化：未完成的条目按本阶段停留天数降序（同天按编号）。 */
export function agingRows(items: TrackingItem[]): TrackingItem[] {
  return items.filter((i) => !i.done).sort((a, b) => b.stageDays - a.stageDays || byKey(a, b));
}

/** 超过阈值天数没有进展记录的条目（顺序同任务老化）。 */
export const staleRows = (items: TrackingItem[]): TrackingItem[] => agingRows(items).filter((i) => i.stale);

export type BoardColumn = { key: string; label: string; color: string | null; items: TrackingItem[] };

/**
 * 按阶段看板的列。选定产品时：该产品流程中非已完成、已取消的状态各一列（按顺序）；
 * 全部产品时：按类别「收集」（有条目时才显示）、「未开始」「进行中」分列。最后一列「工作项」。已完成的条目不上看板。
 */
export function boardColumns(list: Pick<TrackingList, 'products' | 'items'>, productId: string | null): BoardColumn[] {
  const open = list.items.filter((i) => !i.done);
  const reqs = open.filter((i) => i.kind === 'requirement');
  const work: BoardColumn = { key: 'work-items', label: '工作项', color: null, items: open.filter((i) => i.kind === 'work_item') };
  const product = productId ? list.products.find((p) => p.id === productId) : undefined;
  if (product) {
    return [
      ...product.states
        .filter((s) => s.category !== 'completed' && s.category !== 'canceled')
        .map((s) => ({ key: s.key, label: s.label, color: s.color, items: reqs.filter((i) => i.stage.key === s.key) })),
      work,
    ];
  }
  const inCategory = (category: string) => reqs.filter((i) => i.stage.category === category);
  const backlog = inCategory('backlog');
  return [
    ...(backlog.length > 0 ? [{ key: 'backlog', label: '收集', color: null, items: backlog }] : []),
    { key: 'unstarted', label: '未开始', color: null, items: inCategory('unstarted') },
    { key: 'started', label: '进行中', color: null, items: inCategory('started') },
    work,
  ];
}

export type OwnerGroup = { id: string | null; name: string; items: TrackingItem[]; paused: number; blocked: number; aging: number };

/** 按负责人分组：按姓名排序，没有负责人的排最后；组标题的暂停、阻塞、老化数只算未完成的条目。 */
export function ownerGroups(items: TrackingItem[]): OwnerGroup[] {
  const map = new Map<string, OwnerGroup>();
  for (const i of items) {
    const key = i.owner?.id ?? '';
    let g = map.get(key);
    if (!g) {
      g = { id: i.owner?.id ?? null, name: i.owner?.displayName ?? '未指定负责人', items: [], paused: 0, blocked: 0, aging: 0 };
      map.set(key, g);
    }
    g.items.push(i);
    if (i.done) continue;
    if (i.paused) g.paused += 1;
    if (i.blockers.count > 0) g.blocked += 1;
    if (i.aging !== 'normal') g.aging += 1;
  }
  return [...map.values()].sort((a, b) => (a.id === null ? 1 : b.id === null ? -1 : a.name.localeCompare(b.name, 'zh-CN')));
}

/** 停留天数的底色：超过标黄天数为黄，超过标红天数为红。 */
export const AGING_CLASS: Record<TrackingItem['aging'], string> = {
  normal: '',
  warn: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  alert: 'bg-destructive/10 text-destructive',
};
export const AGING_LABEL: Record<TrackingItem['aging'], string> = { normal: '', warn: '超过标黄天数', alert: '超过标红天数' };
