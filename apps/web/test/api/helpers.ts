import { createTestDb } from '@flower/core/testing';
import { type App, createApi } from '@/server/api';

export async function makeApp(): Promise<{ app: App; cleanup: () => Promise<void> }> {
  const t = await createTestDb();
  const app = createApi({ db: t.db, secureCookies: false, publicUrl: 'http://localhost:3000' });
  return { app, cleanup: t.cleanup };
}

export function sessionFrom(res: Response): string {
  const m = /flower_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '');
  if (!m) throw new Error('响应中没有会话 cookie');
  return m[1]!;
}

export async function call(
  app: App,
  method: string,
  path: string,
  opts: { session?: string; token?: string; body?: unknown } = {},
  // 测试直接读取任意响应字段，逐个声明类型不划算
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ status: number; body: any; res: Response }> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.session) headers.cookie = `flower_session=${opts.session}`;
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await app.request(`/api/v1${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.clone().text();
  return { status: res.status, body: text ? JSON.parse(text) : null, res };
}

export async function initAndLogin(app: App): Promise<string> {
  const r = await call(app, 'POST', '/setup', {
    body: {
      admin: { email: 'owner@example.com', name: 'Owner', password: 'password123' },
      org: { name: '测试组织', slug: 'acme' },
    },
  });
  if (r.status !== 201) throw new Error(`初始化失败：${JSON.stringify(r.body)}`);
  return sessionFrom(r.res);
}
