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
  INVALID_RELATED: 400,
  RELATED_CONFLICT: 400,
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

/** 逗号分隔的查询参数 → 去空白后的列表；空时为 undefined。 */
export const csvParam = (v: string | undefined): string[] | undefined => {
  const list = v?.split(',').map((s) => s.trim()).filter(Boolean);
  return list?.length ? list : undefined;
};

/**
 * multipart 不是 JSON，普通表单就能跨站提交，所以上传接口自己拒绝跨站请求：
 * 浏览器带 Sec-Fetch-Site 时只接受 same-origin 与 none；不带时，有 Origin 就要求与请求的 host 一致。
 * 两者都没有的是非浏览器客户端（如 Token），不受 CSRF 影响。
 */
function assertSameOrigin(c: Context): void {
  const site = c.req.header('sec-fetch-site');
  const origin = c.req.header('origin');
  const sameOrigin = site !== undefined ? site === 'same-origin' || site === 'none' : origin === undefined || URL.parse(origin)?.host === new URL(c.req.url).host;
  if (!sameOrigin) throw new AppError('forbidden', '不接受来自其他站点的上传请求');
}

/**
 * 读取 multipart 上传的 file 字段。先拒绝跨站请求；没有 Content-Length 或明显超过上限时不读请求体直接拒绝；
 * 文件本身的大小与类型由服务函数按文件头再校验一次。
 */
export async function readUpload(c: Context, maxBytes: number, tooLarge: string): Promise<{ filename: string; bytes: Uint8Array }> {
  assertSameOrigin(c);
  const contentType = (c.req.header('content-type') ?? '').toLowerCase();
  if (!contentType.startsWith('multipart/form-data')) throw new AppError('invalid', '请求必须使用 multipart/form-data');
  const length = c.req.header('content-length');
  if (length === undefined) throw new AppError('invalid', '上传请求缺少 Content-Length');
  if (Number(length) > maxBytes + 64 * 1024) throw new AppError('invalid', tooLarge);
  let body: Record<string, string | File>;
  try {
    body = (await c.req.parseBody()) as Record<string, string | File>;
  } catch {
    throw new AppError('invalid', '上传内容无法解析');
  }
  const file = body.file;
  if (!(file instanceof File)) throw new AppError('invalid', '缺少文件');
  return { filename: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
}
