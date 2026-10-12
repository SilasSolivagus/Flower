import { describe, expect, it } from 'vitest';
import type { NotificationChannel, NotificationSchedule } from '@/lib/types';
import { channelFormBody, channelToForm, deliveryApiQuery, deliveryUrlQuery, emptyChannelForm, filterSummary, parseDeliveryFilter, parseRecipients, scheduleState, toggle } from './model';

const email: NotificationChannel = {
  id: 'c1',
  kind: 'email',
  name: '邮件',
  groupLabel: null,
  configHint: 'smtp.example.com:465 · robot@example.com → 2 个收件人',
  settings: { host: 'smtp.example.com', port: 465, secure: true, user: 'robot@example.com', from: 'robot@example.com', to: ['a@example.com', 'b@example.com'] },
  rateLimitPerMin: 60,
  allowedProductIds: [],
  enabled: true,
  createdAt: '2026-10-10T00:00:00.000Z',
  updatedAt: '2026-10-10T00:00:00.000Z',
  usage: { rules: 0, schedules: 0, deliveries: 0 },
};

describe('通道表单', () => {
  it('新建：带完整配置与默认上限', () => {
    const f = { ...emptyChannelForm('wecom_robot'), name: '研发群', url: 'http://127.0.0.1:9/send?key=k' };
    expect(f.rateLimitPerMin).toBe('20');
    expect(channelFormBody(f, false)).toEqual({ kind: 'wecom_robot', name: '研发群', groupLabel: null, rateLimitPerMin: 20, allowedProductIds: [], enabled: true, config: { url: 'http://127.0.0.1:9/send?key=k' } });
  });

  it('修改：敏感字段留空时不带；邮件回填非敏感字段，收件人按逗号、分号、空白拆分', () => {
    const f = channelToForm(email);
    expect(f).toMatchObject({ host: 'smtp.example.com', port: '465', to: 'a@example.com, b@example.com', pass: '' });
    expect(channelFormBody(f, true)).toEqual({
      name: '邮件',
      groupLabel: null,
      rateLimitPerMin: 60,
      allowedProductIds: [],
      enabled: true,
      config: { host: 'smtp.example.com', port: 465, secure: true, user: 'robot@example.com', from: 'robot@example.com', to: ['a@example.com', 'b@example.com'] },
    });
    const wecom = { ...emptyChannelForm('wecom_robot'), name: '研发群' };
    expect(channelFormBody(wecom, true)).not.toHaveProperty('config');
    expect(channelFormBody({ ...emptyChannelForm('webhook'), name: 'h', clearSecret: true }, true)).toMatchObject({ config: { clearSecret: true } });
    expect(parseRecipients('a@example.com，b@example.com; c@example.com\n')).toEqual(['a@example.com', 'b@example.com', 'c@example.com']);
    expect(toggle(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggle(['a', 'b'], 'a')).toEqual(['b']);
  });
});

describe('发送记录筛选', () => {
  it('地址栏 ↔ 筛选；无效值忽略；日期按所在时区换算为起止时间', () => {
    const f = parseDeliveryFilter(new URLSearchParams('kind=schedule&status=bogus&from=2026-10-09&to=2026-10-10&channel=c1'));
    expect(f).toEqual({ channel: 'c1', kind: 'schedule', status: '', from: '2026-10-09', to: '2026-10-10', before: '' });
    expect(deliveryUrlQuery(f)).toBe('channel=c1&kind=schedule&from=2026-10-09&to=2026-10-10');
    // UTC+8：getTimezoneOffset() 为 -480
    expect(deliveryApiQuery(f, -480)).toBe('channel=c1&kind=schedule&from=2026-10-08T16%3A00%3A00.000Z&to=2026-10-10T16%3A00%3A00.000Z');
    expect(deliveryApiQuery({ ...f, from: '', to: '', before: 'x|y' }, 0)).toBe('channel=c1&kind=schedule&before=x%7Cy');
  });
});

describe('规则与定时推送的展示', () => {
  it('过滤条件摘要', () => {
    const lookups = { states: new Map([['doing', '进行中']]), priorities: new Map([['p0', 'P0']]), nodes: new Map([['n1', '存储']]), fields: new Map([['priority', '优先级']]) };
    expect(filterSummary({}, lookups)).toBe('全部');
    expect(filterSummary({ states: ['doing'], priorities: ['p0', 'p9'], nodeIds: ['n1'], documentStatuses: ['review'], fields: ['priority'] }, lookups)).toBe(
      '状态：进行中 · 优先级：P0、p9 · 结构树：存储 · PRD 状态：评审中 · 字段：优先级',
    );
  });

  it('定时推送状态：告警优先，其次停用', () => {
    const s = { enabled: true, alertState: 'normal' } as NotificationSchedule;
    expect(scheduleState(s)).toBe('normal');
    expect(scheduleState({ ...s, enabled: false })).toBe('disabled');
    expect(scheduleState({ ...s, enabled: false, alertState: 'alert' })).toBe('alert');
  });
});
