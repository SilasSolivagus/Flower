import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from './api';

afterEach(() => vi.unstubAllGlobals());

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn<typeof fetch>(async () => new Response(body === undefined ? null : JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('api', () => {
  it('GET 返回 JSON，路径加上 /api/v1 前缀', async () => {
    const f = mockFetch(200, { ok: true });
    await expect(api('/me')).resolves.toEqual({ ok: true });
    expect(f).toHaveBeenCalledWith('/api/v1/me', expect.objectContaining({ method: 'GET' }));
  });

  it('带 body 时发送 JSON 与 content-type', async () => {
    const f = mockFetch(201, { id: 1 });
    await api('/orgs', { method: 'POST', body: { name: 'x' } });
    const init = f.mock.calls[0]![1] as RequestInit;
    expect(init.body).toBe('{"name":"x"}');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('204 返回 undefined', async () => {
    mockFetch(204, undefined);
    await expect(api('/auth/logout', { method: 'POST' })).resolves.toBeUndefined();
  });

  it('错误响应抛出 ApiError，保留 code、message、details', async () => {
    mockFetch(400, { error: { code: 'invalid', message: '请求参数有误', details: [{ path: 'a', message: 'b' }] } });
    const e = await api('/x').catch((err) => err);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ status: 400, code: 'invalid', message: '请求参数有误', details: [{ path: 'a', message: 'b' }] });
  });

  it('非 JSON 的错误响应也有中文提示', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('oops', { status: 502 })));
    await expect(api('/x')).rejects.toMatchObject({ status: 502, code: 'internal', message: '服务暂时不可用，请稍后重试' });
  });
});
