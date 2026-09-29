import type { S } from './legacy-types';

export const normTitle = (s: string): string => s.normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();

export const aliasKey = (s: string): string => s.normalize('NFKC').replace(/\s+/g, '').toLowerCase();

export const splitNames = (s: S | undefined): string[] =>
  (s ?? '').split(/[、,，/;；]+/).map((x) => x.trim()).filter(Boolean);

export const splitPlatforms = (s: S | undefined): string[] =>
  (s ?? '').split(/[,，、]+/).map((x) => x.trim()).filter(Boolean);

export function parseJsonArray(s: S | undefined): string[] {
  try {
    const v: unknown = JSON.parse(s ?? '[]');
    return Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

const LEGACY_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const LEGACY_NAIVE_DATETIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;
const LEGACY_ZONED_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2}|[+-]\d{2})$/;

/**
 * 旧系统的时间有三种写法：`YYYY-MM-DD`、无时区的 `YYYY-MM-DD HH:MM[:SS]`/`YYYY-MM-DDTHH:MM[:SS]`（按 UTC 处理）、
 * 带 `Z` 或显式偏移量的 ISO 8601。用允许列表逐一匹配，其余一律视为无效返回 null，不把裸字符串交给
 * `new Date()`（会按本地时区解释）。
 */
export function parseLegacyTime(s: S | undefined): Date | null {
  const t = s?.trim();
  if (!t) return null;
  let iso: string;
  if (LEGACY_DATE_ONLY.test(t)) iso = `${t}T00:00:00Z`;
  else if (LEGACY_NAIVE_DATETIME.test(t)) iso = `${t.replace(' ', 'T')}Z`;
  else if (LEGACY_ZONED_DATETIME.test(t)) iso = t;
  else return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function parseLegacyDate(s: S | undefined): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s?.trim() ?? '');
  return m ? m[1]! : null;
}

/** 日期加天数；天数可为小数（半天），结束落在某天中途时取次日，即该天仍未结束。 */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Math.ceil(days));
  return d.toISOString().slice(0, 10);
}
