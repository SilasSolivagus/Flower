export type ParsedNumber = { ok: true; value: number | null } | { ok: false; message: string };

/** 工期、延期输入：空 = 未填；以半天为单位，范围 min–365。提示文字与服务端校验一致。 */
export function parseHalfDays(text: string, min: number, label: '工期' | '延期'): ParsedNumber {
  const s = text.trim();
  if (!s) return { ok: true, value: null };
  const n = Number(s);
  if (!Number.isFinite(n) || n < min || n > 365 || !Number.isInteger(n * 2)) return { ok: false, message: `${label}以半天为单位，范围 ${min}–365 天` };
  return { ok: true, value: n };
}

/** 手动进度输入：空 = 按工期推算；否则为 0–100 的整数。 */
export function parseProgress(text: string): ParsedNumber {
  const s = text.trim();
  if (!s) return { ok: true, value: null };
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0 || n > 100) return { ok: false, message: '进度应为 0–100 的整数' };
  return { ok: true, value: n };
}
