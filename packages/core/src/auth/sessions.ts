import { and, eq, gt, lt } from 'drizzle-orm';
import { randomToken, sha256 } from '../crypto';
import { accounts, sessions } from '../db/schema';
import type { Queryable } from '../db/tx';
import { AppError } from '../errors';
import { type AccountView, normalizeEmail, toAccountView } from './accounts';
import { hashPassword, verifyPassword } from './password';
import { assertAttemptsWithinLimit, assertNotThrottled, clearLoginFailures, recordLoginAttempt, throttleKeys } from './throttle';

export const SESSION_COOKIE = 'flower_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type SessionMeta = { ip?: string | null; userAgent?: string | null };

/** Lazily compute and cache a dummy argon2id hash for timing-constant login verification. */
let dummyPasswordHashPromise: Promise<string> | null = null;
async function getDummyPasswordHash(): Promise<string> {
  if (!dummyPasswordHashPromise) {
    dummyPasswordHashPromise = hashPassword('');
  }
  return dummyPasswordHashPromise;
}

export async function createSession(
  q: Queryable,
  accountId: string,
  meta: SessionMeta = {},
  expiresAt: Date = new Date(Date.now() + SESSION_TTL_MS),
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken();
  await q.insert(sessions).values({
    accountId,
    tokenHash: sha256(token),
    expiresAt,
    ip: meta.ip ?? null,
    userAgent: meta.userAgent ?? null,
  });
  return { token, expiresAt };
}

export async function resolveSession(q: Queryable, token: string): Promise<AccountView | null> {
  const [row] = await q
    .select({ account: accounts })
    .from(sessions)
    .innerJoin(accounts, eq(accounts.id, sessions.accountId))
    .where(and(eq(sessions.tokenHash, sha256(token)), gt(sessions.expiresAt, new Date())));
  return row ? toAccountView(row.account) : null;
}

export async function revokeSession(q: Queryable, token: string): Promise<void> {
  await q.delete(sessions).where(eq(sessions.tokenHash, sha256(token)));
}

export async function purgeExpiredSessions(q: Queryable, now: Date = new Date()): Promise<number> {
  const rows = await q.delete(sessions).where(lt(sessions.expiresAt, now)).returning({ id: sessions.id });
  return rows.length;
}

export async function login(
  q: Queryable,
  input: { email: string; password: string },
  meta: SessionMeta = {},
): Promise<{ token: string; expiresAt: Date; account: AccountView }> {
  const now = new Date();
  const keys = throttleKeys(input.email, meta.ip);
  await assertNotThrottled(q, keys, now);
  // 计数发生在校验密码之前，且是一条原子 upsert：并发请求不会因为先查后写而漏计或撞主键。
  const attempts = await recordLoginAttempt(q, keys, now);
  assertAttemptsWithinLimit(attempts, keys, now);
  const [row] = await q.select().from(accounts).where(eq(accounts.email, normalizeEmail(input.email)));
  const passwordHash = row?.passwordHash ?? (await getDummyPasswordHash());
  const passwordValid = await verifyPassword(passwordHash, input.password);
  if (!row || !passwordValid) {
    throw new AppError('unauthenticated', '邮箱或密码错误');
  }
  await clearLoginFailures(q, keys[0]!.key);
  await purgeExpiredSessions(q);
  await q.update(accounts).set({ lastLoginAt: new Date() }).where(eq(accounts.id, row.id));
  const session = await createSession(q, row.id, meta);
  return { ...session, account: toAccountView(row) };
}
