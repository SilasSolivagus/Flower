import { AppError, pgErrorCode, SESSION_COOKIE } from '@flower/core';
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
  precondition_failed: 412,
  already_initialized: 409,
  rate_limited: 429,
} as const;

export function errorHandler(err: Error, c: Context) {
  if (err instanceof AppError) {
    return c.json({ error: { code: err.code, message: err.message, details: err.details ?? null } }, STATUS[err.code]);
  }
  if (err instanceof HTTPException) return err.getResponse();
  if (pgErrorCode(err) === '22P02') {
    return c.json({ error: { code: 'not_found', message: '资源不存在', details: null } }, 404);
  }
  console.error(err);
  return c.json({ error: { code: 'internal', message: '服务器内部错误', details: null } }, 500);
}

export async function readJson<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  const contentType = (c.req.header('content-type') ?? '').toLowerCase().split(';')[0]?.trim();
  if (contentType !== 'application/json') {
    throw new AppError('invalid', '请求必须使用 application/json');
  }
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

/** 从 X-Forwarded-For 中取可信的客户端 IP：跳过 `FLOWER_TRUSTED_PROXY_HOPS` 个反向代理注入的地址。 */
export function clientIpFromForwardedFor(forwardedFor: string | undefined, trustedProxyHops: number): string | null {
  if (trustedProxyHops <= 0) return null;
  const parts = forwardedFor?.split(',').map((p) => p.trim()) ?? [];
  const ip = parts[parts.length - trustedProxyHops];
  return ip || null;
}

export function sessionMeta(c: Context): { ip: string | null; userAgent: string | null } {
  const trustedProxyHops = Number.parseInt(process.env.FLOWER_TRUSTED_PROXY_HOPS ?? '0', 10) || 0;
  return {
    ip: clientIpFromForwardedFor(c.req.header('x-forwarded-for'), trustedProxyHops),
    userAgent: c.req.header('user-agent') ?? null,
  };
}
