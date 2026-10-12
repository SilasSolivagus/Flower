import { assertCron, type ChannelConfig, channelConfigHint, type ChannelKind, DEFAULT_RATE_LIMIT, encryptConfig, isPrivateTargetError, parseChannelConfig } from '@flower/core';
import { parseLegacyTime } from './normalize';
import type { PlanContext } from './plan-types';

const PUSH_SOURCES: Record<string, 'overview_card' | 'new_requirements'> = { overview: 'overview_card', newreqs: 'new_requirements' };
/** 123plane 没有保存摘要时间表时的默认值（与 123plane 的 wecom-digest-scheduler 一致）。 */
const PLANE_DEFAULT_DIGEST = ['09:00', '12:00', '18:00'];
/** 时间表为空（已停用）时给定时推送的占位 cron；推送本身是停用的。 */
const DISABLED_DIGEST_CRON = '0 18 * * *';

/** 旧推送日志里出现的 webhook 地址只保留 key 末 4 位，与通道的脱敏提示一致。 */
export function maskWebhookKeys(text: string): string {
  return text.replace(/([?&]key=)([^&\s"'<>]+)/gi, (_m, prefix: string, key: string) => `${prefix}****${key.slice(-4)}`);
}

/** 时间表里的一项是否为有效的 H:MM / HH:MM 时间。 */
function isDigestTime(t: string): boolean {
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  return !!m && Number(m[1]) <= 23 && Number(m[2]) <= 59;
}

/** 123plane 的摘要时间表：没有保存 → 默认时间；空数组 → 停用；无法解析 → 默认时间（与 123plane 相同）。返回其中的全部字符串，无效的时间由调用方报告。 */
export function planeDigestTimes(raw: string | undefined): string[] {
  if (raw === undefined) return PLANE_DEFAULT_DIGEST;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return PLANE_DEFAULT_DIGEST;
  }
  if (!Array.isArray(parsed)) return PLANE_DEFAULT_DIGEST;
  return parsed.filter((x): x is string => typeof x === 'string');
}

/** HH:MM 列表 → cron：同一分钟的合成一条（小时用逗号连接）。 */
export function digestCrons(times: string[]): string[] {
  const byMinute = new Map<number, number[]>();
  for (const t of times.filter(isDigestTime)) {
    const [h, m] = t.split(':').map(Number) as [number, number];
    byMinute.set(m, [...(byMinute.get(m) ?? []), h]);
  }
  return [...byMinute.entries()]
    .sort((a, b) => Math.min(...a[1]) - Math.min(...b[1]))
    .map(([m, hours]) => `${m} ${[...new Set(hours)].sort((a, b) => a - b).join(',')} * * *`);
}

/**
 * push 群、推送计划、推送对象、推送日志与 123plane 的企微地址、摘要时间表、SMTP → 通道、定时推送、发送记录。
 * 通道一律停用（生产群地址，开发阶段不能误发）；配置用 FLOWER_SECRET_KEY 加密；定时推送不排期，由后台循环排期。
 */
export function buildNotifications(ctx: PlanContext): void {
  const { push, plane } = ctx.data;
  const out = ctx.report.notifications;
  const names = new Set<string>();
  const uniqueName = (name: string): string => {
    const base = name.trim() || '未命名通道';
    let v = base;
    for (let i = 2; names.has(v); i++) v = `${base} (${i})`;
    names.add(v);
    return v;
  };
  const addChannel = (key: string, source: string, kind: ChannelKind, name: string, groupLabel: string | null, raw: unknown, createdAt: Date): string | null => {
    let config: ChannelConfig;
    try {
      config = parseChannelConfig(kind, raw);
    } catch (e) {
      // 原因里不写网址、主机与密码
      out.skipped.push({ what: `${source} 通道「${name}」`, reason: isPrivateTargetError(e) ? '地址指向内网或本机，未导入' : '配置不完整或网址无效' });
      return null;
    }
    if (!ctx.opts.secretKey) {
      ctx.problem('缺少 FLOWER_SECRET_KEY，无法加密推送通道配置');
      return null;
    }
    const id = ctx.id('notification-channel', key);
    const finalName = uniqueName(name);
    ctx.rows.notificationChannels.push({
      id,
      orgId: ctx.orgId,
      kind,
      name: finalName,
      groupLabel,
      config: encryptConfig(config, ctx.opts.secretKey),
      configHint: channelConfigHint(kind, config),
      rateLimitPerMin: DEFAULT_RATE_LIMIT[kind],
      allowedProductIds: [],
      enabled: false,
      createdAt,
      updatedAt: createdAt,
    });
    out.channels.push({ source, name: finalName, kind, enabled: false });
    return id;
  };

  const groupChannel = new Map<number, string>();
  for (const g of push.groups) {
    const id = addChannel(`push-group:${g.id}`, 'push', 'wecom_robot', g.name, g.name, { url: g.webhook_url }, ctx.time(g.created_at));
    if (id) groupChannel.set(g.id, id);
  }

  const taskSchedule = new Map<number, string>();
  for (const t of push.tasks) {
    const source = PUSH_SOURCES[t.source_type];
    let cron: string | null = null;
    try {
      cron = t.trigger_type === 'cron' && t.cron_expr ? assertCron(t.cron_expr) : null;
    } catch {
      cron = null;
    }
    if (!source || !cron) {
      out.skipped.push({ what: `push 推送计划「${t.name}」`, reason: `不支持的内容来源或触发方式（${t.source_type} / ${t.trigger_type}）` });
      continue;
    }
    const channelIds = push.taskTargets.filter((x) => x.task_id === t.id).flatMap((x) => groupChannel.get(x.group_id) ?? []);
    const id = ctx.id('notification-schedule', `push-task:${t.id}`);
    ctx.rows.notificationSchedules.push({
      id,
      orgId: ctx.orgId,
      productId: ctx.productId,
      name: t.name,
      cron,
      timezone: t.timezone || 'Asia/Shanghai',
      source,
      sourceConfig: source === 'new_requirements' ? { emptyBehavior: 'skip', onlineSourceKeys: ['online_issue'] } : { image: true },
      channelIds,
      enabled: t.enabled === 1,
      nextRunAt: null,
      lastRunAt: parseLegacyTime(t.last_run),
      lastSuccessAt: parseLegacyTime(t.last_success),
      consecutiveFailures: t.consecutive_failures,
      failThreshold: Math.min(10, Math.max(1, t.fail_threshold)),
      alertState: t.alert_state ? 'alert' : 'normal',
      createdAt: ctx.asOfTime,
      updatedAt: ctx.asOfTime,
    });
    taskSchedule.set(t.id, id);
    out.schedules.push({ source: 'push', name: t.name, kind: source, cron, enabled: t.enabled === 1, channels: channelIds.length });
  }

  let orphanLogs = 0;
  for (const l of push.pushLogs) {
    const scheduleId = l.task_id === null ? undefined : taskSchedule.get(l.task_id);
    const channelId = l.group_id === null ? undefined : groupChannel.get(l.group_id);
    if (!scheduleId || !channelId) {
      orphanLogs++;
      continue;
    }
    const at = ctx.time(l.sent_at);
    const sent = l.status === 'ok';
    ctx.rows.notificationDeliveries.push({
      id: ctx.id('notification-delivery', `push-log:${l.id}`),
      orgId: ctx.orgId,
      kind: 'schedule',
      scheduleId,
      channelId,
      payload: { type: 'legacy', content: maskWebhookKeys(l.content) },
      status: sent ? 'sent' : 'dead',
      attempts: 1,
      response: l.error === null ? null : maskWebhookKeys(l.error),
      sentAt: sent ? at : null,
      createdAt: at,
      legacyKey: `push_logs:${l.id}`,
    });
  }
  if (orphanLogs > 0) out.skipped.push({ what: `push 推送日志 ${orphanLogs} 条`, reason: '对应的推送计划或群没有迁移' });
  out.deliveries = ctx.rows.notificationDeliveries.length;

  const s = plane.notifySettings;
  const reqUrl = s.wecom_requirement_webhook_url?.trim();
  const requirementChannel = reqUrl ? addChannel('plane:wecom_requirement', '123plane', 'wecom_robot', '123plane 需求通知', '123plane', { url: reqUrl }, ctx.asOfTime) : null;
  const dailyUrl = s.wecom_daily_webhook_url?.trim();
  if (dailyUrl) addChannel('plane:wecom_daily', '123plane', 'wecom_robot', '123plane 日报', '123plane', { url: dailyUrl }, ctx.asOfTime);
  if (s.wecom_digest_schedule !== undefined || reqUrl) {
    const all = planeDigestTimes(s.wecom_digest_schedule);
    const times = all.filter(isDigestTime);
    if (times.length < all.length) out.skipped.push({ what: `123plane 变更摘要时间 ${all.length - times.length} 个`, reason: '不是有效的时间（时:分），未导入' });
    const crons = times.length ? digestCrons(times) : [DISABLED_DIGEST_CRON];
    if (!requirementChannel) {
      out.skipped.push({ what: '123plane 变更摘要时间表', reason: reqUrl ? '需求通知通道没有导入，无法确定发到哪里' : '没有需求通知地址，无法确定发到哪里' });
    } else {
      crons.forEach((cron, i) => {
        const name = crons.length > 1 ? `123plane 变更摘要 ${i + 1}` : '123plane 变更摘要';
        ctx.rows.notificationSchedules.push({
          id: ctx.id('notification-schedule', `plane-digest:${i}`),
          orgId: ctx.orgId,
          productId: ctx.productId,
          name,
          cron,
          timezone: 'Asia/Shanghai',
          source: 'digest',
          sourceConfig: {},
          channelIds: [requirementChannel],
          enabled: times.length > 0,
          nextRunAt: null,
          createdAt: ctx.asOfTime,
          updatedAt: ctx.asOfTime,
        });
        out.schedules.push({ source: '123plane', name, kind: 'digest', cron, enabled: times.length > 0, channels: 1 });
      });
    }
  }
  const host = s.smtp_host?.trim();
  const user = s.smtp_user?.trim();
  const recipients = s.email_recipients?.trim();
  if (host && user && s.smtp_pass && recipients) {
    const port = Number.parseInt(s.smtp_port ?? '465', 10) || 465;
    addChannel(
      'plane:smtp',
      '123plane',
      'email',
      '123plane 邮件',
      '123plane',
      { host, port, secure: port === 465, user, pass: s.smtp_pass, from: user, to: recipients.split(/[,，;；\s]+/).filter(Boolean) },
      ctx.asOfTime,
    );
  } else if (host || user || s.smtp_pass || recipients) {
    out.skipped.push({ what: '123plane SMTP 设置', reason: '配置不完整' });
  }
}
