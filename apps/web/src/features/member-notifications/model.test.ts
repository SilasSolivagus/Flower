import { describe, expect, it } from 'vitest';
import type { NotificationSettings } from '@/lib/types';
import { actorLabel, groupByDay, pageApiQuery, pageUrlQuery, parseNotificationFilter, prefCell, relativeTime, unreadBadge } from './model';

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

  it('操作人：当前姓名；系统告警为「系统」', () => {
    expect(actorLabel({ kind: 'mentioned', actor: { id: 'x', displayName: '张三' } })).toBe('张三');
    expect(actorLabel({ kind: 'system_alert', actor: null })).toBe('系统');
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
