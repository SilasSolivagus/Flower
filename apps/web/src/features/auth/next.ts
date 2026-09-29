/** 校验登录后跳转目标，避免开放重定向（如 `/\evil.com`、`/\t/evil.com` 等会被浏览器归一化为外部地址的写法）。 */
export function safeNext(next: string | null): string {
  if (!next) return '/';
  let u: URL;
  try {
    u = new URL(next, 'http://x');
  } catch {
    return '/';
  }
  if (u.origin !== 'http://x') return '/';
  if (!next.startsWith('/')) return '/';
  return u.pathname + u.search + u.hash;
}
