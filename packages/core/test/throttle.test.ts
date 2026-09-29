import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAccount } from '../src/auth/accounts';
import { createSession, login, purgeExpiredSessions, resolveSession } from '../src/auth/sessions';
import { LOGIN_LIMITS, recordLoginAttempt, throttleKeys } from '../src/auth/throttle';
import { createTestDb } from './db';

let t: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  t = await createTestDb();
  await createAccount(t.db, { email: 'th@example.com', name: 'Th', password: 'password123' });
});
afterAll(() => t.cleanup());

describe('登录限流', () => {
  it('同一邮箱连续失败 5 次后锁定，正确密码也被拒绝；锁定过期后恢复并清零', async () => {
    for (let i = 0; i < 5; i++) {
      await expect(login(t.db, { email: 'th@example.com', password: 'wrong-pass' }, { ip: '10.0.0.1' })).rejects.toMatchObject({ code: 'unauthenticated' });
    }
    await expect(login(t.db, { email: 'TH@example.com', password: 'password123' }, { ip: '10.0.0.2' })).rejects.toMatchObject({
      code: 'rate_limited',
    });
    // 模拟锁定窗口已经过期：锁定与计数窗口都要往前拨，否则新的一次尝试仍会把陈旧的失败计数继续累加。
    await t.db.execute(sql`update auth_throttle set locked_until = now() - interval '1 second', window_start = now() - interval '20 minutes'`);
    const ok = await login(t.db, { email: 'th@example.com', password: 'password123' }, { ip: '10.0.0.2' });
    expect(ok.account.email).toBe('th@example.com');
    const rows = await t.db.execute(sql`select key from auth_throttle where key = ${throttleKeys('th@example.com')[0]!.key}`);
    expect(rows).toHaveLength(0);
  });

  it('同一 IP 失败 20 次后锁定该 IP', async () => {
    for (let i = 0; i < 20; i++) {
      await expect(login(t.db, { email: `nobody${i}@example.com`, password: 'x' }, { ip: '10.9.9.9' })).rejects.toMatchObject({ code: 'unauthenticated' });
    }
    await expect(login(t.db, { email: 'th@example.com', password: 'password123' }, { ip: '10.9.9.9' })).rejects.toMatchObject({ code: 'rate_limited' });
  });
});

describe('限流计数的原子性', () => {
  it('同一邮箱并发失败尝试不会 500，且校验密码的次数不超过上限', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        login(t.db, { email: 'concurrent@example.com', password: 'wrong-pass' }, { ip: '10.1.1.1' }),
      ),
    );
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    const codes = results.map((r) => (r as PromiseRejectedResult).reason?.code);
    expect(codes.every((c) => c === 'unauthenticated' || c === 'rate_limited')).toBe(true);
    expect(codes.filter((c) => c === 'unauthenticated').length).toBeLessThanOrEqual(LOGIN_LIMITS.email.max);
  });

  it('限流窗口过期后失败计数从 1 重新开始', async () => {
    const keys = throttleKeys('window@example.com');
    const t0 = new Date('2026-01-01T00:00:00Z');
    const first = await recordLoginAttempt(t.db, keys, t0);
    expect(first[0]!.failures).toBe(1);
    const second = await recordLoginAttempt(t.db, keys, new Date(t0.getTime() + 1000));
    expect(second[0]!.failures).toBe(2);
    const afterWindow = new Date(t0.getTime() + LOGIN_LIMITS.email.windowMs + 1000);
    const third = await recordLoginAttempt(t.db, keys, afterWindow);
    expect(third[0]!.failures).toBe(1);
  });
});

describe('成功登录不消耗 IP 限流预算', () => {
  it('同一 IP 连续 25 次成功登录不会被限流（IP 上限是 20）', async () => {
    const acc = await createAccount(t.db, { email: 'nat@example.com', name: 'Nat', password: 'password123' });
    for (let i = 0; i < 25; i++) {
      const ok = await login(t.db, { email: 'nat@example.com', password: 'password123' }, { ip: '10.2.2.2' });
      expect(ok.account.id).toBe(acc.id);
    }
  });
});

describe('过期会话清理', () => {
  it('删除已过期的会话，保留有效会话', async () => {
    const acc = await createAccount(t.db, { email: 'purge@example.com', name: 'P', password: 'password123' });
    const old = await createSession(t.db, acc.id, {}, new Date(Date.now() - 1000));
    const fresh = await createSession(t.db, acc.id);
    expect(await purgeExpiredSessions(t.db)).toBeGreaterThanOrEqual(1);
    expect(await resolveSession(t.db, old.token)).toBeNull();
    expect(await resolveSession(t.db, fresh.token)).not.toBeNull();
  });
});
