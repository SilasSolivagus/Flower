import { eq, inArray } from 'drizzle-orm';
import { authThrottle } from '../db/schema';
import type { Queryable } from '../db/tx';
import { AppError } from '../errors';
import { normalizeEmail } from './accounts';

export type ThrottleRule = { max: number; windowMs: number; lockMs: number };

export const LOGIN_LIMITS = {
  email: { max: 5, windowMs: 15 * 60_000, lockMs: 15 * 60_000 },
  ip: { max: 20, windowMs: 15 * 60_000, lockMs: 15 * 60_000 },
} as const satisfies Record<string, ThrottleRule>;

export function throttleKeys(email: string, ip?: string | null): Array<{ key: string; rule: ThrottleRule }> {
  const keys: Array<{ key: string; rule: ThrottleRule }> = [{ key: `email:${normalizeEmail(email)}`, rule: LOGIN_LIMITS.email }];
  if (ip) keys.push({ key: `ip:${ip}`, rule: LOGIN_LIMITS.ip });
  return keys;
}

export async function assertNotThrottled(q: Queryable, keys: Array<{ key: string }>, now: Date = new Date()): Promise<void> {
  const rows = await q.select().from(authThrottle).where(inArray(authThrottle.key, keys.map((k) => k.key)));
  const lockedUntil = rows
    .map((r) => r.lockedUntil)
    .filter((d): d is Date => d !== null && d.getTime() > now.getTime())
    .sort((a, b) => b.getTime() - a.getTime())[0];
  if (lockedUntil) {
    const minutes = Math.max(1, Math.ceil((lockedUntil.getTime() - now.getTime()) / 60_000));
    throw new AppError('rate_limited', `登录失败次数过多，请在 ${minutes} 分钟后再试`);
  }
}

export async function recordLoginFailure(
  q: Queryable,
  keys: Array<{ key: string; rule: ThrottleRule }>,
  now: Date = new Date(),
): Promise<void> {
  for (const { key, rule } of keys) {
    const [row] = await q.select().from(authThrottle).where(eq(authThrottle.key, key));
    const windowExpired = !row || row.windowStart.getTime() + rule.windowMs <= now.getTime();
    const failures = windowExpired ? 1 : row.failures + 1;
    const lockedUntil = failures >= rule.max ? new Date(now.getTime() + rule.lockMs) : null;
    const values = { failures, windowStart: windowExpired ? now : row.windowStart, lockedUntil };
    if (row) await q.update(authThrottle).set(values).where(eq(authThrottle.key, key));
    else await q.insert(authThrottle).values({ key, ...values });
  }
}

export async function clearLoginFailures(q: Queryable, key: string): Promise<void> {
  await q.delete(authThrottle).where(eq(authThrottle.key, key));
}
