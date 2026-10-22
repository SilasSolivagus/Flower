import { describe, expect, it } from 'vitest';
import type { NotificationSettings } from '@/lib/types';
import { actorLabel, groupByDay, groupInbox, notificationCopySegments, pageApiQuery, pageUrlQuery, parseNotificationFilter, prefCell, relativeTime, scrubLegacyRoleCopy, unreadBadge } from './model';

const NOW = new Date('2026-10-12T10:00:00Z');
const TZ = 'Asia/Shanghai';
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

describe('铃铛与列表', () => {
  it('未读数：0 不显示，超过 99 显示 99+', () => {
    expect(unreadBadge(0)).toBeNull();
    expect(unreadBadge(7)).toBe('7');
    expect(unreadBadge(120)).toBe('99+');
  });

  it('相对时间', () => {
    expect(relativeTime(ago(30_000), NOW, TZ)).toBe('刚刚');
    expect(relativeTime(ago(5 * 60_000), NOW, TZ)).toBe('5 分钟前');
    expect(relativeTime(ago(3 * 3_600_000), NOW, TZ)).toBe('3 小时前');
    expect(relativeTime(ago(2 * 86_400_000), NOW, TZ)).toBe('2 天前');
    expect(relativeTime(ago(10 * 86_400_000), NOW, TZ)).toBe('10-02');
  });

  it('按今天与更早分组（按时区判断日期），空组不出现', () => {
    const today = { createdAt: '2026-10-11T17:00:00Z' };
    const earlier = { createdAt: '2026-10-11T15:00:00Z' };
    expect(groupByDay([today, earlier], NOW, TZ)).toEqual([
      { label: '今天', items: [today] },
      { label: '更早', items: [earlier] },
    ]);
    expect(groupByDay([earlier], NOW, TZ).map((g) => g.label)).toEqual(['更早']);
  });

  it('通知中心：要你做的事在前，关注动态在后；空的分区不出现', () => {
    const mention = { kind: 'mentioned' as const, id: 'm' };
    const assigned = { kind: 'assigned' as const, id: 'a' };
    const follow = { kind: 'followed_change' as const, id: 'f' };
    const alert = { kind: 'system_alert' as const, id: 's' };
    const signoff = { kind: 'signoff_due' as const, id: 'g' };
    expect(groupInbox([follow, mention, alert, assigned, signoff])).toEqual([
      { label: '要你做的事', items: [mention, assigned, signoff] },
      { label: '全部动态', items: [follow, alert] },
    ]);
    expect(groupInbox([follow])).toEqual([{ label: '全部动态', items: [follow] }]);
    expect(groupInbox([])).toEqual([]);
  });

  it('中英关键词整段保留，例如「已生成 PRD」不断开', () => {
    expect(notificationCopySegments('把简报状态从「讨论中」改为「已生成 PRD」')).toEqual([
      { text: '把简报状态从「讨论中」改为「', keep: false },
      { text: '已生成 PRD', keep: true },
      { text: '」', keep: false },
    ]);
    expect(notificationCopySegments('改为「可以写 PRD」').filter((s) => s.keep).map((s) => s.text)).toEqual(['可以写 PRD']);
    expect(notificationCopySegments('把你设为需求负责人')).toEqual([{ text: '把你设为需求负责人', keep: false }]);
  });

  it('操作人：当前姓名；系统告警为「系统」', () => {
    expect(actorLabel({ kind: 'mentioned', actor: { id: 'x', displayName: '张三' } })).toBe('张三');
    expect(actorLabel({ kind: 'mentioned', actor: { id: 'x', displayName: '决策人（测试）' } })).toBe('确认人（测试）');
    expect(actorLabel({ kind: 'system_alert', actor: null })).toBe('系统');
    expect(scrubLegacyRoleCopy('把你设为决策人')).toBe('把你设为确认人');
    expect(scrubLegacyRoleCopy('你是这份简报的简报决策人')).toBe('你是这份简报的简报确认人');
    expect(scrubLegacyRoleCopy('决策人甲发表了评论')).toBe('决策人甲发表了评论');
  });

  it('通知页的筛选：地址栏与接口参数；不认识的值按默认', () => {
    const f = parseNotificationFilter(new URLSearchParams('read=unread&kind=assigned'));
    expect(f).toEqual({ read: 'unread', kind: 'assigned' });
    expect(pageUrlQuery(f)).toBe('read=unread&kind=assigned');
    expect(pageApiQuery(f)).toBe('filter=unread&kind=assigned&limit=30');
    expect(parseNotificationFilter(new URLSearchParams('read=x&kind=y'))).toEqual({ read: 'all', kind: '' });
    expect(pageApiQuery({ read: 'all', kind: '' })).toBe('filter=all&limit=30');
  });
});

describe('偏好表的可用情况', () => {
  const base: NotificationSettings = { prefs: [], wecom: { userid: 'zhangsan', bindEnabled: true, productChannels: 1 }, email: { address: 'a@example.com', channelConfigured: true } };
  it('企业微信：未绑定或没有产品指定个人提醒通道时置灰并说明', () => {
    expect(prefCell(base, 'wecom')).toEqual({ disabled: false, reason: null });
    expect(prefCell({ ...base, wecom: { ...base.wecom, userid: null } }, 'wecom').reason).toBe('还没有绑定企业微信');
    expect(prefCell({ ...base, wecom: { ...base.wecom, productChannels: 0 } }, 'wecom').reason).toBe('你能看到的产品都还没有指定个人提醒通道');
  });
  it('邮件：组织没有邮件通道或成员没有邮箱时置灰；站内总是可用', () => {
    expect(prefCell({ ...base, email: { address: 'a@example.com', channelConfigured: false } }, 'email').reason).toBe('组织还没有指定个人通知邮件通道');
    expect(prefCell({ ...base, email: { address: null, channelConfigured: true } }, 'email').reason).toBe('你的成员资料里没有邮箱');
    expect(prefCell({ ...base, wecom: { userid: null, bindEnabled: false, productChannels: 0 } }, 'inApp')).toEqual({ disabled: false, reason: null });
  });
});
