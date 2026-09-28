import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { changePassword, createAccount, getAccount, updateProfile } from '../src/auth/accounts';
import { hashPassword, verifyPassword } from '../src/auth/password';
import { createSession, login, resolveSession, revokeSession } from '../src/auth/sessions';
import { AppError } from '../src/errors';
import { createTestDb } from './db';

let t: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.cleanup());

describe('密码', () => {
  it('哈希为 argon2id，且能校验', async () => {
    const h = await hashPassword('password123');
    expect(h.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(h, 'password123')).toBe(true);
    expect(await verifyPassword(h, 'wrong-password')).toBe(false);
    expect(await verifyPassword('not-a-hash', 'x')).toBe(false);
  });
});

describe('账号', () => {
  it('创建账号时邮箱统一转为小写', async () => {
    const a = await createAccount(t.db, { email: ' Alice@Example.COM ', name: 'Alice', password: 'password123' });
    expect(a.email).toBe('alice@example.com');
    expect(a.isInstanceAdmin).toBe(false);
  });

  it('重复邮箱返回 conflict', async () => {
    await expect(
      createAccount(t.db, { email: 'alice@example.com', name: 'A2', password: 'password123' }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('密码过短、邮箱格式错误、姓名为空时返回 invalid', async () => {
    await expect(createAccount(t.db, { email: 'b@example.com', name: 'B', password: 'short' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(createAccount(t.db, { email: 'bad', name: 'B', password: 'password123' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(createAccount(t.db, { email: 'c@example.com', name: '  ', password: 'password123' })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('修改资料与密码', async () => {
    const a = await createAccount(t.db, { email: 'd@example.com', name: 'D', password: 'password123' });
    const u = await updateProfile(t.db, a.id, { name: 'Dora', preferences: { theme: 'dark' } });
    expect(u).toMatchObject({ name: 'Dora', preferences: { theme: 'dark' } });
    await expect(changePassword(t.db, a.id, { currentPassword: 'wrong-pass', newPassword: 'newpassword1' })).rejects.toMatchObject({ code: 'invalid' });
    await changePassword(t.db, a.id, { currentPassword: 'password123', newPassword: 'newpassword1' });
    await expect(login(t.db, { email: 'd@example.com', password: 'newpassword1' })).resolves.toBeTruthy();
    expect((await getAccount(t.db, a.id))?.name).toBe('Dora');
  });
});

describe('会话', () => {
  it('登录后可以用令牌解析账号，注销后失效', async () => {
    await createAccount(t.db, { email: 'e@example.com', name: 'E', password: 'password123' });
    const { token, account } = await login(t.db, { email: 'E@example.com', password: 'password123' });
    expect(account.email).toBe('e@example.com');
    expect((await resolveSession(t.db, token))?.id).toBe(account.id);
    await revokeSession(t.db, token);
    expect(await resolveSession(t.db, token)).toBeNull();
  });

  it('邮箱或密码错误时返回统一提示', async () => {
    const err1 = await login(t.db, { email: 'e@example.com', password: 'bad-password' }).catch((e) => e);
    const err2 = await login(t.db, { email: 'nobody@example.com', password: 'password123' }).catch((e) => e);
    expect(err1).toBeInstanceOf(AppError);
    expect(err1.code).toBe('unauthenticated');
    expect(err1.message).toBe(err2.message);
  });

  it('过期会话无法解析', async () => {
    const a = await createAccount(t.db, { email: 'f@example.com', name: 'F', password: 'password123' });
    const { token } = await createSession(t.db, a.id, {}, new Date(Date.now() - 1000));
    expect(await resolveSession(t.db, token)).toBeNull();
  });

  it('登录时间恒定防止邮箱枚举', async () => {
    await createAccount(t.db, { email: 'timing@example.com', name: 'T', password: 'password123' });

    // Warm up dummy hash cache by attempting login with non-existent email once
    await login(t.db, { email: 'warmup@example.com', password: 'x' }).catch(() => {});

    // Measure login with wrong password (account exists)
    const start1 = performance.now();
    await login(t.db, { email: 'timing@example.com', password: 'wrong-password' }).catch(() => {});
    const duration1 = performance.now() - start1;

    // Measure login with non-existent email (account doesn't exist)
    const start2 = performance.now();
    await login(t.db, { email: 'nonexistent@example.com', password: 'password123' }).catch(() => {});
    const duration2 = performance.now() - start2;

    // Unknown email should take at least 30% of the time of wrong password
    // This ensures verifyPassword was called in both paths
    expect(duration2).toBeGreaterThanOrEqual(duration1 * 0.3);
  });
});
