import { hash, verify } from '@node-rs/argon2';
import { AppError } from '../errors';

export const MIN_PASSWORD_LENGTH = 8;

export function assertPasswordPolicy(pw: string): void {
  if (pw.length < MIN_PASSWORD_LENGTH) {
    throw new AppError('invalid', `密码至少 ${MIN_PASSWORD_LENGTH} 位`);
  }
}

/** @node-rs/argon2 默认算法为 argon2id。 */
export const hashPassword = (pw: string): Promise<string> => hash(pw);

export async function verifyPassword(passwordHash: string, pw: string): Promise<boolean> {
  try {
    return await verify(passwordHash, pw);
  } catch {
    return false;
  }
}
