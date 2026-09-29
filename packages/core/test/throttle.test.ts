import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAccount } from '../src/auth/accounts';
import { createSession, login, purgeExpiredSessions, resolveSession } from '../src/auth/sessions';
import { throttleKeys } from '../src/auth/throttle';
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
    await t.db.execute(sql`update auth_throttle set locked_until = now() - interval '1 second'`);
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
