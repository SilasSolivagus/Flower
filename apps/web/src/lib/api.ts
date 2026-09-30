export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details: unknown,
  ) {
    super(message);
  }
}

/** 请求没有到达服务器（断网、DNS 失败、连接被重置等）时的提示。 */
export const NETWORK_ERROR_MESSAGE = '网络连接失败，请检查网络后重试';

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const hasBody = init.body !== undefined;
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      method: init.method ?? 'GET',
      headers: hasBody ? { 'content-type': 'application/json' } : {},
      body: hasBody ? JSON.stringify(init.body) : undefined,
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError(0, 'network', NETWORK_ERROR_MESSAGE, null);
  }
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string; details?: unknown } } | null;
  if (!res.ok) {
    const e = data?.error;
    throw new ApiError(res.status, e?.code ?? 'internal', e?.message ?? '服务暂时不可用，请稍后重试', e?.details ?? null);
  }
  return data as T;
}

/** 「条件未满足」类错误的 details.unmet；其他形状返回空数组。 */
export function unmetFrom(details: unknown): string[] {
  const list = (details as { unmet?: unknown } | null)?.unmet;
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
}

/** 403 / 404：页面显示「无权访问」；其他错误（5xx、网络失败）显示「重试」。 */
export function isAccessDenied(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 403 || error.status === 404);
}
