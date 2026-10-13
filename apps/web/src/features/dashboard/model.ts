import type { DashboardCards } from '@/lib/types';

export type DashboardFilter = { kind: 'days'; days: 30 | 90 | 180 } | { kind: 'custom'; from: string; to: string } | { kind: 'iteration'; iterationId: string };

export const DEFAULT_FILTER: DashboardFilter = { kind: 'days', days: 90 };

export const RANGE_OPTIONS = [
  { value: '30', label: '近 30 天' },
  { value: '90', label: '近 90 天' },
  { value: '180', label: '近 180 天' },
  { value: 'custom', label: '自定义' },
] as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 86_400_000;

/** 地址栏参数 → 筛选。iteration 优先，其次 from + to，再次 range；不认识的值回到默认（近 90 天）。组织汇总不接受 iteration。 */
export function filterFromParams(p: { get(name: string): string | null }, allowIteration = true): DashboardFilter {
  const iteration = p.get('iteration');
  if (allowIteration && iteration && UUID_RE.test(iteration)) return { kind: 'iteration', iterationId: iteration };
  const from = p.get('from');
  const to = p.get('to');
  if (from && to && DATE_RE.test(from) && DATE_RE.test(to)) return { kind: 'custom', from, to };
  const range = p.get('range');
  if (range === '30') return { kind: 'days', days: 30 };
  if (range === '180') return { kind: 'days', days: 180 };
  return DEFAULT_FILTER;
}

/** 筛选 → 查询串（接口与地址栏共用，不含 product）；默认值为空串。 */
export function filterQuery(f: DashboardFilter): string {
  if (f.kind === 'iteration') return `iteration=${encodeURIComponent(f.iterationId)}`;
  if (f.kind === 'custom') return `from=${f.from}&to=${f.to}`;
  return f.days === 90 ? '' : `range=${f.days}`;
}

/** 时间段下拉框的值：近 N 天为天数，自定义为 custom。 */
export const rangeValue = (f: DashboardFilter): string => (f.kind === 'days' ? String(f.days) : 'custom');

export function dashboardHref(org: string, productId: string, f: DashboardFilter = DEFAULT_FILTER): string {
  const q = filterQuery(f);
  return `/${org}/dashboard?product=${productId}${q ? `&${q}` : ''}`;
}

export function orgDashboardHref(org: string, f: DashboardFilter): string {
  const q = filterQuery(f);
  return `/${org}/settings/dashboard${q ? `?${q}` : ''}`;
}

/** 自定义时间段的前端预校验，与服务端规则一致；服务端仍会完整校验。 */
export function customRangeError(from: string, to: string, today: string): string | null {
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) return '请选择开始和结束日期';
  if (from > to) return '结束日期不能早于开始日期';
  if (to > today) return '结束日期不能晚于今天';
  if ((Date.parse(to) - Date.parse(from)) / DAY_MS + 1 > 366) return '自定义时间段不超过 366 天';
  return null;
}

export type WindowView = { from: string; to: string; days: number; previousFrom: string; previousTo: string; iteration: { id: string; name: string } | null };

export function windowText(w: WindowView): string {
  const prefix = w.iteration ? `迭代「${w.iteration.name}」：` : '';
  return `${prefix}${w.from} 至 ${w.to}（${w.days} 天），与上期 ${w.previousFrom} 至 ${w.previousTo} 比较`;
}

/** 各指标的口径（设计 §3），悬停「?」时显示。 */
export const METRIC_HELP = {
  throughput: '时间段内每周进入「已完成」类状态的需求数；同一需求反复进出时按最后一次进入计，目前不在已完成类的需求不计。卡片为周均值。周从周一开始，按组织时区划分；已删除的需求不计，已取消不算完成。',
  leadTime: '需求创建到最后一次进入「已完成」类状态的天数，按完成日落在时间段内的需求计算；显示中位数与 85 分位。',
  flowTime: '需求第一次进入「进行中」类状态到最后一次进入「已完成」类状态的天数；没有经过进行中的需求不计。显示中位数与 85 分位。',
  wip: '处于「进行中」类状态的需求数，由状态流转记录推算。卡片为时间段最后一天结束时的数量，趋势为每周日结束时的数量。',
  releaseOnTime: '时间段内已发布的版本中，发布日不晚于基线日期的比例；没有基线日期的版本用所属迭代的结束日代替并标「按迭代结束日计」，两者都没有的版本不计入。',
  commitment: '只统计在 Flower 里开始、有承诺范围快照的迭代：快照内的需求在迭代结束时（进行中的迭代计到现在）处于「已完成」类的比例，已取消的不进入分母；同时列出中途加入、移出的需求数。',
  special: '每个专项内本产品需求的已完成数 ÷（总数 − 已取消数）。专项属于组织，这里只统计本产品的需求。',
  reviewDays: '检查项从开始评审（第一次离开「未开始」或第一次签字）到最终通过的天数中位数，按通过日落在时间段内的检查项计算。',
  rejection: '时间段内出现过「驳回」的检查项 ÷ 时间段内有结论（通过或驳回）的检查项；先驳回后通过的计为驳回过。只统计在 Flower 里记录的检查项变化。',
  stuck: '当前处于「进行中」类状态的需求，按具体状态统计数量与平均停留天数（自进入当前状态起），不受时间段影响。',
} as const;

export type MetricUnit = 'perWeek' | 'days' | 'count' | 'rate';
export type CardKey = keyof DashboardCards;
export type CardSpec = { key: CardKey; label: string; unit: MetricUnit; better: 'up' | 'down'; help: keyof typeof METRIC_HELP };

export const CARD_SPECS: CardSpec[] = [
  { key: 'throughputPerWeek', label: '吞吐量（周均）', unit: 'perWeek', better: 'up', help: 'throughput' },
  { key: 'leadTimeMedian', label: '前置时间中位数', unit: 'days', better: 'down', help: 'leadTime' },
  { key: 'flowTimeMedian', label: '流动时间中位数', unit: 'days', better: 'down', help: 'flowTime' },
  { key: 'wip', label: '当前在制品', unit: 'count', better: 'down', help: 'wip' },
  { key: 'releaseOnTimeRate', label: '版本按期达成率', unit: 'rate', better: 'up', help: 'releaseOnTime' },
  { key: 'rejectionRate', label: '驳回率', unit: 'rate', better: 'down', help: 'rejection' },
];

/** 在制品取时间段最后一天结束时的数量：最后一天是今天时叫「当前在制品」，否则叫「期末在制品」。 */
export const cardLabel = (spec: CardSpec, endsToday: boolean): string => (spec.key === 'wip' && !endsToday ? '期末在制品' : spec.label);

export const formatDays = (n: number | null): string => (n === null ? '暂无数据' : `${n.toFixed(1)} 天`);
export const formatRate = (n: number | null): string => (n === null ? '暂无数据' : `${Math.round(n * 100)}%`);

export function formatMetric(value: number | null, unit: MetricUnit): string {
  if (value === null) return '暂无数据';
  if (unit === 'rate') return formatRate(value);
  if (unit === 'days') return formatDays(value);
  if (unit === 'perWeek') return `${value.toFixed(1)} 条/周`;
  return String(value);
}

/** 卡片「暂无数据」时的原因。 */
export function emptyReason(key: CardKey, completedCount: number): string {
  switch (key) {
    case 'throughputPerWeek':
    case 'wip':
      return '时间段内还没有需求';
    case 'leadTimeMedian':
      return '时间段内没有完成的需求';
    case 'flowTimeMedian':
      return completedCount === 0 ? '时间段内没有完成的需求' : '时间段内完成的需求都没有经过进行中状态';
    case 'releaseOnTimeRate':
      return '时间段内没有能判断是否按期的已发布版本';
    case 'rejectionRate':
      return '时间段内没有有结论的检查项';
  }
}

export type Tone = 'good' | 'bad' | 'neutral';
export const TONE_CLASS: Record<Tone, string> = { good: 'text-primary', bad: 'text-destructive', neutral: 'text-muted-foreground' };
export type Delta = { direction: 'up' | 'down' | 'flat'; tone: Tone; text: string };

function amountText(diff: number, unit: MetricUnit): string {
  if (unit === 'rate') return `${Math.round(diff * 100)} 个百分点`;
  if (unit === 'days') return `${diff.toFixed(1)} 天`;
  if (unit === 'perWeek') return `${diff.toFixed(1)} 条/周`;
  return String(diff);
}

/** 与上一个同长度时间段相比；任一侧没有数据时不显示。比例差不足 0.5 个百分点、其他差不足 0.05 视为持平。 */
export function cardDelta(pair: { value: number | null; previous: number | null }, unit: MetricUnit, better: 'up' | 'down'): Delta | null {
  if (pair.value === null || pair.previous === null) return null;
  const diff = pair.value - pair.previous;
  if (Math.abs(diff) < (unit === 'rate' ? 0.005 : 0.05)) return { direction: 'flat', tone: 'neutral', text: '与上期持平' };
  const direction = diff > 0 ? 'up' : 'down';
  return { direction, tone: direction === better ? 'good' : 'bad', text: `比上期${direction === 'up' ? '升' : '降'} ${amountText(Math.abs(diff), unit)}` };
}

/** 周一日期 → 「月/日」。 */
export const weekLabel = (monday: string): string => `${Number(monday.slice(5, 7))}/${Number(monday.slice(8, 10))}`;

/** 纵轴上限：不小于最大值的 1、2、5 × 10^k；没有正数时为 1。 */
export function niceMax(values: Array<number | null>): number {
  const m = Math.max(0, ...values.filter((v): v is number => v !== null));
  if (m <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(m));
  for (const k of [1, 2, 5]) if (k * p >= m) return k * p;
  return 10 * p;
}

/** 折线坐标（保留 1 位小数）：值为 null 的周断开成多段；只有一个点时放在中间。 */
export function linePoints(values: Array<number | null>, width: number, height: number, max: number): Array<Array<{ x: number; y: number }>> {
  const n = values.length;
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const segments: Array<Array<{ x: number; y: number }>> = [];
  let cur: Array<{ x: number; y: number }> = [];
  values.forEach((v, i) => {
    if (v === null) {
      if (cur.length > 0) segments.push(cur);
      cur = [];
      return;
    }
    const x = n === 1 ? width / 2 : (i * width) / (n - 1);
    cur.push({ x: r1(x), y: r1(height - (Math.min(v, max) / max) * height) });
  });
  if (cur.length > 0) segments.push(cur);
  return segments;
}

const SOURCE_NOTE = { baseline: '', planned: '', iteration: '，按迭代结束日计' } as const;

/**
 * 版本一行的结论。到期日来源见 dueSource：基线日期、计划日期或所属迭代结束日。
 * 已发布的没有到期日（基线与迭代结束日都没有）时无法判断；未发布的没有到期日（计划日期与迭代结束日都没有）时只标未发布。
 */
export function releaseVerdict(r: {
  status: 'planned' | 'released';
  dueDate: string | null;
  dueSource: 'baseline' | 'planned' | 'iteration' | null;
  onTime: boolean | null;
  overdueDays: number | null;
}): { text: string; tone: Tone } {
  const note = r.dueSource ? SOURCE_NOTE[r.dueSource] : '';
  if (r.status === 'released') {
    if (r.dueDate === null || r.onTime === null) return { text: '无法判断：没有基线日期，所属迭代也没有结束日', tone: 'neutral' };
    return r.onTime ? { text: `按期${note}`, tone: 'good' } : { text: `逾期 ${r.overdueDays} 天${note}`, tone: 'bad' };
  }
  if (r.dueDate === null) return { text: '未发布，没有计划日期，所属迭代也没有结束日', tone: 'neutral' };
  const overdue = (r.overdueDays ?? 0) > 0;
  if (!overdue) return { text: `未发布${note}`, tone: 'neutral' };
  return { text: `未发布，已过${r.dueSource === 'iteration' ? '迭代结束日' : '计划日'} ${r.overdueDays} 天`, tone: 'bad' };
}
