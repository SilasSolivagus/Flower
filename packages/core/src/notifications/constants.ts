/**
 * 推送的取值、中文名称与共用类型。浏览器安全：本文件不导入任何模块，页面经 `@flower/core/notifications` 引用。
 */

export const CHANNEL_KINDS = ['wecom_robot', 'webhook', 'email'] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];
export const CHANNEL_KIND_LABELS: Record<ChannelKind, string> = { wecom_robot: '企业微信机器人', webhook: 'Webhook', email: '邮件' };
/** 每分钟发送上限的默认值：企微机器人 20 条/分钟，其余 60。 */
export const DEFAULT_RATE_LIMIT: Record<ChannelKind, number> = { wecom_robot: 20, webhook: 60, email: 60 };

export const TEMPLATE_FORMATS = ['text', 'markdown', 'markdown_v2', 'template_card', 'email'] as const;
export type TemplateFormat = (typeof TEMPLATE_FORMATS)[number];
export const TEMPLATE_FORMAT_LABELS: Record<TemplateFormat, string> = { text: '文本', markdown: 'Markdown', markdown_v2: 'Markdown v2（表格、列表，无字色）', template_card: '模板卡片', email: '邮件' };

/** 事件规则可以订阅的领域事件。 */
export const NOTIFIABLE_EVENT_TYPES = [
  'requirement.created',
  'requirement.state_changed',
  'requirement.field_changed',
  'requirement.assignment_added',
  'requirement.iteration_changed',
  'document.status_changed',
  'check_item.signed',
  'release.released',
  'iteration.status_changed',
] as const;
export type NotifiableEventType = (typeof NOTIFIABLE_EVENT_TYPES)[number];
export const EVENT_TYPE_LABELS: Record<NotifiableEventType, string> = {
  'requirement.created': '新建需求',
  'requirement.state_changed': '需求状态变化',
  'requirement.field_changed': '需求字段变化',
  'requirement.assignment_added': '需求新增分配',
  'requirement.iteration_changed': '需求所属迭代变化',
  'document.status_changed': 'PRD 状态变化',
  'check_item.signed': '检查项签字',
  'release.released': '版本发布',
  'iteration.status_changed': '迭代状态变化',
};
export const isNotifiableEventType = (type: string): type is NotifiableEventType => (NOTIFIABLE_EVENT_TYPES as readonly string[]).includes(type);

export const RULE_MODES = ['immediate', 'digest'] as const;
export type RuleMode = (typeof RULE_MODES)[number];
export const RULE_MODE_LABELS: Record<RuleMode, string> = { immediate: '即时推送', digest: '合并到变更摘要' };

export const SCHEDULE_SOURCES = ['overview_card', 'new_requirements', 'digest'] as const;
export type ScheduleSource = (typeof SCHEDULE_SOURCES)[number];
export const SCHEDULE_SOURCE_LABELS: Record<ScheduleSource, string> = { overview_card: '概览卡片', new_requirements: '新需求', digest: '变更摘要' };

export const DELIVERY_KINDS = ['rule', 'schedule', 'test'] as const;
export type DeliveryKind = (typeof DELIVERY_KINDS)[number];
export const DELIVERY_KIND_LABELS: Record<DeliveryKind, string> = { rule: '事件规则', schedule: '定时推送', test: '测试消息' };

/** failed 表示本次失败、等待重试；dead 表示已放弃。 */
export const DELIVERY_STATUSES = ['pending', 'sending', 'sent', 'failed', 'dead'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];
export const DELIVERY_STATUS_LABELS: Record<DeliveryStatus, string> = { pending: '待发送', sending: '发送中', sent: '已发送', failed: '失败待重试', dead: '已放弃' };

export const ALERT_STATES = ['normal', 'alert'] as const;
export type AlertState = (typeof ALERT_STATES)[number];

export const BUILTIN_TEMPLATE_KEYS = ['event', 'overview_card', 'new_requirements', 'digest'] as const;
export type BuiltinTemplateKey = (typeof BUILTIN_TEMPLATE_KEYS)[number];

export const SCHEDULE_DEFAULT_TIMEZONE = 'Asia/Shanghai';
/** 第 n 次失败后等待的秒数；第 MAX_ATTEMPTS 次失败后放弃。 */
export const RETRY_DELAYS_SECONDS = [30, 120, 600, 3600] as const;
export const MAX_ATTEMPTS = 5;
export const RESPONSE_MAX_CHARS = 2000;

/** 事件规则的过滤条件：条件之间为「且」，同一条件内多个值为「或」；不适用于该事件的条件视为通过。 */
export type RuleFilter = { states?: string[]; priorities?: string[]; nodeIds?: string[]; documentStatuses?: string[]; fields?: string[] };
export type NewRequirementsConfig = { emptyBehavior: 'skip' | 'notice'; onlineSourceKeys: string[] };
/** image：附带看板图片（只发企微通道）；缺少该键（迁移导入的旧数据）按开启处理。 */
export type OverviewCardConfig = { titlePrefix?: string; image?: boolean };

/** 一次发送的请求体：企微与 Webhook 为 JSON，邮件为主题与正文。 */
export type ChannelPayload = { type: 'json'; body: Record<string, unknown> } | { type: 'email'; subject: string; text: string };
/** 发送记录里的请求体；legacy 为迁移来的 push 推送日志原文。 */
export type DeliveryPayload = ChannelPayload | { type: 'legacy'; content: string };
