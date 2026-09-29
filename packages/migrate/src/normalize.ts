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

/** 旧系统的时间有三种写法：`YYYY-MM-DD`、`YYYY-MM-DD HH:MM:SS`（SQLite，UTC）、ISO 8601。 */
export function parseLegacyTime(s: S | undefined): Date | null {
  const t = s?.trim();
  if (!t) return null;
  let iso = t;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) iso = `${t}T00:00:00Z`;
  else if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(t)) iso = `${t.replace(' ', 'T')}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function parseLegacyDate(s: S | undefined): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s?.trim() ?? '');
  return m ? m[1]! : null;
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
