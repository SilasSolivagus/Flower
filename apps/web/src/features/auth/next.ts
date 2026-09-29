/** 校验登录后跳转目标，避免开放重定向（如 `/\evil.com` 会被浏览器归一化成 `//evil.com`）。 */
export function safeNext(next: string | null): string {
  if (!next) return '/';
  if (!next.startsWith('/')) return '/';
  if (next.startsWith('//')) return '/';
  if (next.includes('\\')) return '/';
  return next;
}
