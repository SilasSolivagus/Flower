import { AppError, SESSION_COOKIE } from '@flower/core';
import type { Context } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import type { z } from 'zod';

const STATUS = {
  invalid: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  already_initialized: 409,
} as const;

export function errorHandler(err: Error, c: Context) {
  if (err instanceof AppError) {
    return c.json({ error: { code: err.code, message: err.message, details: err.details ?? null } }, STATUS[err.code]);
  }
  if (err instanceof HTTPException) return err.getResponse();
  console.error(err);
  return c.json({ error: { code: 'internal', message: '服务器内部错误', details: null } }, 500);
}

export async function readJson<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new AppError('invalid', '请求体不是合法的 JSON');
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    throw new AppError(
      'invalid',
      '请求参数有误',
      r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return r.data;
}

export function setSessionCookie(c: Context, token: string, expiresAt: Date, secure: boolean): void {
  setCookie(c, SESSION_COOKIE, token, { httpOnly: true, sameSite: 'Lax', secure, path: '/', expires: expiresAt });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}

export function sessionMeta(c: Context): { ip: string | null; userAgent: string | null } {
  return {
    ip: c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: c.req.header('user-agent') ?? null,
  };
}
