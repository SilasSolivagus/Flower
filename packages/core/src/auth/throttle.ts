import { eq, inArray, sql } from 'drizzle-orm';
import { authThrottle } from '../db/schema';
import type { Queryable } from '../db/tx';
import { AppError } from '../errors';
import { normalizeEmail } from './accounts';

export type ThrottleRule = { max: number; windowMs: number; lockMs: number };

// 不变量：lockMs >= windowMs。锁定到期后能否恢复计数，依赖窗口本身也已经过期（见 recordLoginAttempt）。
export const LOGIN_LIMITS = {
  email: { max: 5, windowMs: 15 * 60_000, lockMs: 15 * 60_000 },
  ip: { max: 20, windowMs: 15 * 60_000, lockMs: 15 * 60_000 },
} as const satisfies Record<string, ThrottleRule>;

export function throttleKeys(email: string, ip?: string | null): Array<{ key: string; rule: ThrottleRule }> {
  const keys: Array<{ key: string; rule: ThrottleRule }> = [{ key: `email:${normalizeEmail(email)}`, rule: LOGIN_LIMITS.email }];
  if (ip) keys.push({ key: `ip:${ip}`, rule: LOGIN_LIMITS.ip });
  return keys;
}

function rateLimitedError(lockedUntil: Date, now: Date): AppError {
  const minutes = Math.max(1, Math.ceil((lockedUntil.getTime() - now.getTime()) / 60_000));
  return new AppError('rate_limited', `登录失败次数过多，请在 ${minutes} 分钟后再试`);
}

export async function assertNotThrottled(q: Queryable, keys: Array<{ key: string }>, now: Date = new Date()): Promise<void> {
  const rows = await q.select().from(authThrottle).where(inArray(authThrottle.key, keys.map((k) => k.key)));
  const lockedUntil = rows
    .map((r) => r.lockedUntil)
    .filter((d): d is Date => d !== null && d.getTime() > now.getTime())
    .sort((a, b) => b.getTime() - a.getTime())[0];
  if (lockedUntil) throw rateLimitedError(lockedUntil, now);
}

export type ThrottleAttempt = { key: string; failures: number; lockedUntil: Date | null };

/**
 * 原子地为每个 key 记一次登录尝试（在校验密码之前调用，无论密码是否正确）。
 * 用一条 INSERT ... ON CONFLICT DO UPDATE 语句完成「读当前计数 → 判断窗口是否过期 → 计数或重置 → 超过上限才锁定」，
 * 避免并发请求之间先查后写的竞态（丢失更新、或对同一新 key 并发插入导致主键冲突）。
 * 注意锁定的判断是「计数 > max」而不是「>= max」：第 max 次尝试仍然正常放行去校验密码（这次可能是正确密码），
 * 只有超过 max 的第 max+1 次才会在校验密码前被 assertAttemptsWithinLimit 拒绝并置上 locked_until。
 */
export async function recordLoginAttempt(
  q: Queryable,
  keys: Array<{ key: string; rule: ThrottleRule }>,
  now: Date = new Date(),
): Promise<ThrottleAttempt[]> {
  const results: ThrottleAttempt[] = [];
  for (const { key, rule } of keys) {
    const windowExpired = sql`auth_throttle.window_start + (${rule.windowMs} * interval '1 millisecond') <= ${now.toISOString()}::timestamptz`;
    const failuresExpr = sql`(case when ${windowExpired} then 1 else auth_throttle.failures + 1 end)`;
    const initialLockedUntil = 1 > rule.max ? new Date(now.getTime() + rule.lockMs) : null;
    const rows = await q.execute<{ failures: number; locked_until: string | null }>(sql`
      insert into auth_throttle (key, failures, window_start, locked_until)
      values (${key}, 1, ${now.toISOString()}::timestamptz, ${initialLockedUntil?.toISOString() ?? null}::timestamptz)
      on conflict (key) do update set
        failures = ${failuresExpr},
        window_start = case when ${windowExpired} then ${now.toISOString()}::timestamptz else auth_throttle.window_start end,
        locked_until = case
          when ${failuresExpr} > ${rule.max}
          then ${now.toISOString()}::timestamptz + (${rule.lockMs} * interval '1 millisecond')
          else auth_throttle.locked_until
        end
      returning failures, locked_until
    `);
    const row = rows[0]!;
    // 原始 SQL 的 RETURNING 结果不像 drizzle 查询构造器那样自动把 timestamptz 转成 Date，这里手动转换。
    const lockedUntil = row.locked_until === null ? null : new Date(row.locked_until);
    results.push({ key, failures: row.failures, lockedUntil });
  }
  return results;
}

/** 检查 recordLoginAttempt 的返回结果：某个 key 的失败次数超过其上限，说明这次尝试本身已越限，应直接拒绝、不再校验密码。 */
export function assertAttemptsWithinLimit(
  attempts: ThrottleAttempt[],
  keys: Array<{ key: string; rule: ThrottleRule }>,
  now: Date = new Date(),
): void {
  for (const attempt of attempts) {
    const rule = keys.find((k) => k.key === attempt.key)?.rule;
    if (rule && attempt.failures > rule.max) {
      throw rateLimitedError(attempt.lockedUntil ?? new Date(now.getTime() + rule.lockMs), now);
    }
  }
}

export async function clearLoginFailures(q: Queryable, key: string): Promise<void> {
  await q.delete(authThrottle).where(eq(authThrottle.key, key));
}

/**
 * 登录成功时，把这次成功尝试从某个 key 的计数里退回去（失败数减一，不低于 0），不清空整条记录。
 * 用于 IP key：一次成功登录不该消耗同一出口（如公司 NAT）其他用户的限流预算；
 * 该 key 不存在时这条 UPDATE 自然是空操作。
 */
export async function creditSuccessfulLogin(q: Queryable, key: string | undefined): Promise<void> {
  if (!key) return;
  await q
    .update(authThrottle)
    .set({ failures: sql`greatest(${authThrottle.failures} - 1, 0)` })
    .where(eq(authThrottle.key, key));
}
