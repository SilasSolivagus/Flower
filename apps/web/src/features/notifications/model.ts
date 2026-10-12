import { DOCUMENT_STATUS_LABELS } from '@flower/core/markdown';
import {
  type ChannelKind,
  DEFAULT_RATE_LIMIT,
  DELIVERY_KINDS,
  DELIVERY_STATUSES,
  type DeliveryKind,
  type DeliveryStatus,
  type RuleFilter,
} from '@flower/core/notifications';
import type { NotificationChannel, NotificationSchedule } from '@/lib/types';

export type ChannelForm = {
  kind: ChannelKind;
  name: string;
  groupLabel: string;
  url: string;
  secret: string;
  clearSecret: boolean;
  host: string;
  port: string;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
  to: string;
  rateLimitPerMin: string;
  allowedProductIds: string[];
  enabled: boolean;
};

export function emptyChannelForm(kind: ChannelKind = 'wecom_robot'): ChannelForm {
  return {
    kind,
    name: '',
    groupLabel: '',
    url: '',
    secret: '',
    clearSecret: false,
    host: '',
    port: '465',
    secure: true,
    user: '',
    pass: '',
    from: '',
    to: '',
    rateLimitPerMin: String(DEFAULT_RATE_LIMIT[kind]),
    allowedProductIds: [],
    enabled: true,
  };
}

/** 修改时的初值：网址、签名密钥、密码一律留空（留空表示不变）；邮件的非敏感字段回填。 */
export function channelToForm(c: NotificationChannel): ChannelForm {
  const s = c.settings;
  return {
    ...emptyChannelForm(c.kind),
    name: c.name,
    groupLabel: c.groupLabel ?? '',
    rateLimitPerMin: String(c.rateLimitPerMin),
    allowedProductIds: c.allowedProductIds,
    enabled: c.enabled,
    ...(s ? { host: s.host, port: String(s.port), secure: s.secure, user: s.user, from: s.from, to: s.to.join(', ') } : {}),
  };
}

export const parseRecipients = (text: string): string[] =>
  text
    .split(/[,，;；\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);

export const toggle = <T,>(list: T[], value: T): T[] => (list.includes(value) ? list.filter((x) => x !== value) : [...list, value]);

/** 新建：完整配置；修改：只带填写了的敏感字段，没有要改的配置时不带 config。 */
export function channelFormBody(f: ChannelForm, editing: boolean): Record<string, unknown> {
  const base = { name: f.name, groupLabel: f.groupLabel.trim() || null, rateLimitPerMin: Number(f.rateLimitPerMin), allowedProductIds: f.allowedProductIds, enabled: f.enabled };
  const keep = (value: string) => value !== '' || !editing;
  let config: Record<string, unknown>;
  if (f.kind === 'email') {
    config = { host: f.host, port: Number(f.port), secure: f.secure, user: f.user, from: f.from, to: parseRecipients(f.to), ...(keep(f.pass) ? { pass: f.pass } : {}) };
  } else if (f.kind === 'webhook') {
    config = { ...(keep(f.url) ? { url: f.url } : {}), ...(f.secret ? { secret: f.secret } : {}), ...(editing && f.clearSecret ? { clearSecret: true } : {}) };
  } else {
    config = keep(f.url) ? { url: f.url } : {};
  }
  if (editing) return Object.keys(config).length > 0 ? { ...base, config } : base;
  return { kind: f.kind, ...base, config };
}

export type DeliveryFilter = { channel: string; kind: DeliveryKind | ''; status: DeliveryStatus | ''; from: string; to: string; before: string };
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function parseDeliveryFilter(p: URLSearchParams): DeliveryFilter {
  const kind = p.get('kind') ?? '';
  const status = p.get('status') ?? '';
  const day = (v: string | null) => (v && DAY.test(v) ? v : '');
  return {
    channel: p.get('channel') ?? '',
    kind: (DELIVERY_KINDS as readonly string[]).includes(kind) ? (kind as DeliveryKind) : '',
    status: (DELIVERY_STATUSES as readonly string[]).includes(status) ? (status as DeliveryStatus) : '',
    from: day(p.get('from')),
    to: day(p.get('to')),
    before: p.get('before') ?? '',
  };
}

const params = (entries: Array<[string, string]>): string => new URLSearchParams(entries.filter(([, v]) => v !== '')).toString();

/** 地址栏：原样保存筛选（日期为 YYYY-MM-DD）。 */
export function deliveryUrlQuery(f: DeliveryFilter): string {
  return params([
    ['channel', f.channel],
    ['kind', f.kind],
    ['status', f.status],
    ['from', f.from],
    ['to', f.to],
    ['before', f.before],
  ]);
}

/** 本地日期 00:00 对应的 UTC 时间；offsetMinutes 为 Date#getTimezoneOffset() 的值。 */
const localMidnight = (day: string, offsetMinutes: number, plusDays = 0): string => {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + plusDays) + offsetMinutes * 60_000).toISOString();
};

/** 接口查询：起始日 00:00 到结束日次日 00:00（含结束日整天）。 */
export function deliveryApiQuery(f: DeliveryFilter, offsetMinutes: number): string {
  return params([
    ['channel', f.channel],
    ['kind', f.kind],
    ['status', f.status],
    ['from', f.from ? localMidnight(f.from, offsetMinutes) : ''],
    ['to', f.to ? localMidnight(f.to, offsetMinutes, 1) : ''],
    ['before', f.before],
  ]);
}

export const DELIVERY_STATUS_TONE: Record<DeliveryStatus, string> = {
  pending: 'text-muted-foreground',
  sending: 'text-muted-foreground',
  sent: 'text-emerald-700 dark:text-emerald-400',
  failed: 'text-amber-700 dark:text-amber-400',
  dead: 'text-destructive',
};

export type FilterLookups = { states: Map<string, string>; priorities: Map<string, string>; nodes: Map<string, string>; fields: Map<string, string> };

/** 规则过滤条件的一行摘要；查不到名称时显示原 key。 */
export function filterSummary(filter: RuleFilter, l: FilterLookups): string {
  const name = (map: Map<string, string>, keys: string[] | undefined) => (keys ?? []).map((k) => map.get(k) ?? k).join('、');
  const docs = (filter.documentStatuses ?? []).map((k) => (DOCUMENT_STATUS_LABELS as Record<string, string>)[k] ?? k).join('、');
  const parts = [
    filter.states?.length ? `状态：${name(l.states, filter.states)}` : '',
    filter.priorities?.length ? `优先级：${name(l.priorities, filter.priorities)}` : '',
    filter.nodeIds?.length ? `结构树：${name(l.nodes, filter.nodeIds)}` : '',
    docs ? `PRD 状态：${docs}` : '',
    filter.fields?.length ? `字段：${name(l.fields, filter.fields)}` : '',
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : '全部';
}

export function scheduleState(s: Pick<NotificationSchedule, 'enabled' | 'alertState'>): 'alert' | 'disabled' | 'normal' {
  if (s.alertState === 'alert') return 'alert';
  return s.enabled ? 'normal' : 'disabled';
}
