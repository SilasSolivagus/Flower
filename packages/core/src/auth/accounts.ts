import { eq } from 'drizzle-orm';
import { type AccountPreferences, accounts } from '../db/schema';
import type { Queryable } from '../db/tx';
import { AppError, isUniqueViolation } from '../errors';
import { assertPasswordPolicy, hashPassword, verifyPassword } from './password';

export type AccountView = {
  id: string;
  email: string;
  name: string;
  isInstanceAdmin: boolean;
  preferences: AccountPreferences;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

export function assertName(name: string): string {
  const n = name.trim();
  if (n.length === 0 || n.length > 50) throw new AppError('invalid', '姓名不能为空，且不超过 50 个字符');
  return n;
}

export function toAccountView(row: typeof accounts.$inferSelect): AccountView {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    isInstanceAdmin: row.isInstanceAdmin,
    preferences: row.preferences,
  };
}

export async function createAccount(
  q: Queryable,
  input: { email: string; name: string; password: string; isInstanceAdmin?: boolean },
): Promise<AccountView> {
  const email = normalizeEmail(input.email);
  if (!EMAIL_RE.test(email)) throw new AppError('invalid', '邮箱格式不正确');
  const name = assertName(input.name);
  assertPasswordPolicy(input.password);
  try {
    const [row] = await q
      .insert(accounts)
      .values({ email, name, passwordHash: await hashPassword(input.password), isInstanceAdmin: input.isInstanceAdmin ?? false })
      .returning();
    return toAccountView(row!);
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError('conflict', '该邮箱已注册');
    throw e;
  }
}

export async function getAccount(q: Queryable, id: string): Promise<AccountView | null> {
  const [row] = await q.select().from(accounts).where(eq(accounts.id, id));
  return row ? toAccountView(row) : null;
}

export async function updateProfile(
  q: Queryable,
  accountId: string,
  input: { name?: string; preferences?: AccountPreferences },
): Promise<AccountView> {
  const current = await getAccount(q, accountId);
  if (!current) throw new AppError('not_found', '账号不存在');
  const [row] = await q
    .update(accounts)
    .set({
      name: input.name === undefined ? current.name : assertName(input.name),
      preferences: input.preferences === undefined ? current.preferences : { ...current.preferences, ...input.preferences },
    })
    .where(eq(accounts.id, accountId))
    .returning();
  return toAccountView(row!);
}

export async function changePassword(
  q: Queryable,
  accountId: string,
  input: { currentPassword: string; newPassword: string },
): Promise<void> {
  const [row] = await q.select().from(accounts).where(eq(accounts.id, accountId));
  if (!row) throw new AppError('not_found', '账号不存在');
  if (!(await verifyPassword(row.passwordHash, input.currentPassword))) {
    throw new AppError('invalid', '当前密码不正确');
  }
  assertPasswordPolicy(input.newPassword);
  await q.update(accounts).set({ passwordHash: await hashPassword(input.newPassword) }).where(eq(accounts.id, accountId));
}
