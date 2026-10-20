import { MEMBER_NOTIFICATION_KINDS, type MemberNotificationKind, type NotificationPrefChannel } from '@flower/core/notifications';
import type { MemberNotification, NotificationSettings } from '@/lib/types';

export const BELL_TABS = [
  { key: 'all', label: '全部' },
  { key: 'unread', label: '未读' },
  { key: 'mentioned', label: '@我' },
] as const;
export type BellTab = (typeof BELL_TABS)[number]['key'];

/** 铃铛上的未读数：0 不显示，超过 99 显示 99+。 */
export function unreadBadge(count: number): string | null {
  if (count <= 0) return null;
  return count > 99 ? '99+' : String(count);
}

const dayOf = (d: Date, timeZone?: string): string => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

/** 按「今天 / 更早」分组（日期按浏览器时区，测试可传时区），组内保持原顺序，空组不出现。 */
export function groupByDay<T extends { createdAt: string }>(items: T[], now: Date, timeZone?: string): Array<{ label: '今天' | '更早'; items: T[] }> {
  const today = dayOf(now, timeZone);
  const isToday = (n: T) => dayOf(new Date(n.createdAt), timeZone) === today;
  return [
    { label: '今天' as const, items: items.filter(isToday) },
    { label: '更早' as const, items: items.filter((n) => !isToday(n)) },
  ].filter((g) => g.items.length > 0);
}

/** 相对时间：刚刚、n 分钟前、n 小时前、n 天前（7 天内），更早显示 MM-DD。 */
export function relativeTime(iso: string, now: Date, timeZone?: string): string {
  const minutes = Math.floor(Math.max(0, now.getTime() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  return dayOf(new Date(iso), timeZone).slice(5);
}

/** 「谁」：操作人的当前姓名；系统告警为「系统」。 */
export const actorLabel = (n: Pick<MemberNotification, 'actor' | 'kind'>): string => n.actor?.displayName ?? (n.kind === 'system_alert' ? '系统' : '有人');

/** 要你做的事：被 @、被指派、等你签字。关注动态和系统告警是流水。 */
const ACTION_KINDS = new Set<MemberNotificationKind>(['mentioned', 'assigned', 'signoff_due']);

export function isActionNotification(kind: MemberNotificationKind): boolean {
  return ACTION_KINDS.has(kind);
}

/** 通知中心分区：行动项在前，其余动态在后。组内保持原顺序（接口已按时间倒序）。没有条目的分区不出现。 */
export function groupInbox<T extends { kind: MemberNotificationKind }>(items: T[]): Array<{ label: '要你做的事' | '全部动态'; items: T[] }> {
  const actions = items.filter((n) => isActionNotification(n.kind));
  const activity = items.filter((n) => !isActionNotification(n.kind));
  return [
    ...(actions.length > 0 ? [{ label: '要你做的事' as const, items: actions }] : []),
    ...(activity.length > 0 ? [{ label: '全部动态' as const, items: activity }] : []),
  ];
}

export type CopySegment = { text: string; keep: boolean };

/**
 * 中文后紧跟一个空格和英文词时整段不换行，避免铃铛里「已生成 PRD」断成「已生成 / PRD」。
 * 其余文字仍可在标点和空格处换行。
 */
export function notificationCopySegments(text: string): CopySegment[] {
  const glued = /([\u3400-\u9fff]{1,12}) ([A-Za-z][A-Za-z0-9-]{0,20})/g;
  const out: CopySegment[] = [];
  let last = 0;
  for (const m of text.matchAll(glued)) {
    const start = m.index ?? 0;
    if (start > last) out.push({ text: text.slice(last, start), keep: false });
    out.push({ text: `${m[1]} ${m[2]}`, keep: true });
    last = start + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), keep: false });
  if (out.length === 0) out.push({ text, keep: false });
  return out;
}

export type NotificationPageFilter = { read: 'all' | 'unread'; kind: MemberNotificationKind | '' };

export function parseNotificationFilter(p: URLSearchParams): NotificationPageFilter {
  const kind = p.get('kind') ?? '';
  return {
    read: p.get('read') === 'unread' ? 'unread' : 'all',
    kind: (MEMBER_NOTIFICATION_KINDS as readonly string[]).includes(kind) ? (kind as MemberNotificationKind) : '',
  };
}

/** 地址栏里的筛选：只写非默认值。 */
export function pageUrlQuery(f: NotificationPageFilter): string {
  const p = new URLSearchParams();
  if (f.read === 'unread') p.set('read', 'unread');
  if (f.kind) p.set('kind', f.kind);
  return p.toString();
}

/** 通知页请求接口的参数：每页 30 条。 */
export function pageApiQuery(f: NotificationPageFilter): string {
  const p = new URLSearchParams({ filter: f.read });
  if (f.kind) p.set('kind', f.kind);
  p.set('limit', '30');
  return p.toString();
}

/** 偏好表一列能否修改：企业微信要求已绑定、且有产品指定了个人提醒通道；邮件要求组织有个人通知邮件通道、成员有邮箱。 */
export function prefCell(s: NotificationSettings, channel: NotificationPrefChannel): { disabled: boolean; reason: string | null } {
  if (channel === 'wecom') {
    if (!s.wecom.userid) return { disabled: true, reason: '还没有绑定企业微信' };
    if (s.wecom.productChannels === 0) return { disabled: true, reason: '你能看到的产品都还没有指定个人提醒通道' };
  }
  if (channel === 'email') {
    if (!s.email.channelConfigured) return { disabled: true, reason: '组织还没有指定个人通知邮件通道' };
    if (!s.email.address) return { disabled: true, reason: '你的成员资料里没有邮箱' };
  }
  return { disabled: false, reason: null };
}
