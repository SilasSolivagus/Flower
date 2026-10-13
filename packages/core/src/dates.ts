import { AppError } from './errors';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 校验 YYYY-MM-DD，且是真实存在的日期（2026-02-30 不通过）。 */
export function assertIsoDate(value: string, label: string): string {
  const d = new Date(`${value}T00:00:00Z`);
  if (!DATE_RE.test(value) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
    throw new AppError('invalid', `${label}格式应为 YYYY-MM-DD`);
  }
  return value;
}

/** 时区名有效（Intl 认识）则原样返回，否则返回 null。 */
export const validZone = (tz: string | undefined): string | null => {
  if (!tz) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
};
