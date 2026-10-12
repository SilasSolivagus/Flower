import { CronExpressionParser } from 'cron-parser';
import { AppError } from '../errors';

/** 校验 5 段 cron（分 时 日 月 周）并规范化空白；cron-parser 同时接受 6 段（含秒），这里只允许 5 段。 */
export function assertCron(expr: string): string {
  const fields = expr.trim().split(/\s+/).filter(Boolean);
  if (fields.length !== 5) throw new AppError('invalid', '定时规则应为 5 段 cron 表达式（分 时 日 月 周）');
  const normalized = fields.join(' ');
  try {
    CronExpressionParser.parse(normalized, { tz: 'UTC' });
  } catch {
    throw new AppError('invalid', `定时规则「${normalized}」无法解析`);
  }
  return normalized;
}

export function assertTimezone(tz: string): string {
  const v = tz.trim();
  if (!v) throw new AppError('invalid', '请填写时区');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: v });
  } catch {
    throw new AppError('invalid', `时区「${v}」无效`);
  }
  return v;
}

/** 严格晚于 after 的下一次执行时间；cron 按 timezone 的当地时间解释（含夏令时）。 */
export function nextRunAt(cron: string, timezone: string, after: Date): Date {
  const it = CronExpressionParser.parse(cron, { currentDate: after, tz: timezone });
  let next = it.next().toDate();
  while (next.getTime() <= after.getTime()) next = it.next().toDate();
  return next;
}
