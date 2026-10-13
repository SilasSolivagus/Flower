import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLocalStorage, defaultTransport, type Transport } from '@flower/core';
import { createTestDb } from '@flower/core/testing';
import { type App, createApi } from '@/server/api';

/** 接口测试用的应用。推送默认用真实发送器，测试里的通道地址一律指向本机假接收端（test/fake-webhook.ts）；企业微信接口默认指向本机不可达端口。 */
export async function makeApp(opts: { transport?: Transport; tickApi?: boolean; wecomApiBase?: string } = {}): Promise<{ app: App; cleanup: () => Promise<void> }> {
  const t = await createTestDb();
  const storage = createLocalStorage(mkdtempSync(path.join(os.tmpdir(), 'flower-api-storage-')));
  const app = createApi({
    db: t.db,
    secureCookies: false,
    publicUrl: 'http://localhost:3000',
    storage,
    notify: { secretKey: 'api-test-secret-api-test-secret-0001', publicUrl: 'http://localhost:3000', transport: opts.transport ?? defaultTransport },
    tickApi: opts.tickApi ?? false,
    wecomApiBase: opts.wecomApiBase ?? 'http://127.0.0.1:9',
  });
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

/** multipart 上传一个文件（字段名 file）。和浏览器一样带 Content-Length；headers 可追加或覆盖请求头，值为 null 时去掉该头。 */
export async function upload(
  app: App,
  pathname: string,
  opts: { session?: string; token?: string; file: Blob; filename: string; headers?: Record<string, string | null> },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ status: number; body: any }> {
  const form = new FormData();
  form.set('file', opts.file, opts.filename);
  const encoded = new Request('http://localhost/', { method: 'POST', body: form });
  const body = new Uint8Array(await encoded.arrayBuffer());
  const headers: Record<string, string> = { 'content-type': encoded.headers.get('content-type')!, 'content-length': String(body.byteLength) };
  if (opts.session) headers.cookie = `flower_session=${opts.session}`;
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  for (const [k, v] of Object.entries(opts.headers ?? {})) {
    if (v === null) delete headers[k];
    else headers[k] = v;
  }
  const res = await app.request(`/api/v1${pathname}`, { method: 'POST', headers, body });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
