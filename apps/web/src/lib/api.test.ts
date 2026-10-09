import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, apiUpload, isAccessDenied, unmetFrom } from './api';

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

  it('网络不通时抛出中文提示的 ApiError（status 0）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    await expect(api('/x')).rejects.toMatchObject({ status: 0, code: 'network', message: '网络连接失败，请检查网络后重试' });
  });

  it('上传用 FormData，不设 content-type（由浏览器带上 boundary）', async () => {
    const f = mockFetch(201, { attachment: { id: 'a' } });
    await expect(apiUpload('/orgs/acme/documents/d/attachments', new Blob(['x']), 'a.png')).resolves.toEqual({ attachment: { id: 'a' } });
    const init = f.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get('file')).toBeInstanceOf(Blob);
    expect(init.headers).toBeUndefined();
  });
});

describe('unmetFrom', () => {
  it('从错误详情中取出未满足的条件，其他形状返回空数组', () => {
    expect(unmetFrom({ unmet: ['「可行性」需为通过（当前：未开始）', 1] })).toEqual(['「可行性」需为通过（当前：未开始）']);
    expect(unmetFrom([{ path: 'x', message: 'y' }])).toEqual([]);
    expect(unmetFrom(null)).toEqual([]);
  });
});

describe('isAccessDenied', () => {
  it('403 与 404 视为无权访问，其他错误可以重试', () => {
    expect(isAccessDenied(new ApiError(403, 'forbidden', '权限不足', null))).toBe(true);
    expect(isAccessDenied(new ApiError(404, 'not_found', '不存在', null))).toBe(true);
    expect(isAccessDenied(new ApiError(500, 'internal', '服务器内部错误', null))).toBe(false);
    expect(isAccessDenied(new ApiError(0, 'network', '网络连接失败，请检查网络后重试', null))).toBe(false);
    expect(isAccessDenied(new Error('x'))).toBe(false);
  });
});
