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
  const path = u.pathname + u.search + u.hash;
  // 相对路径中的 `.`/`..` 段归一化后可能把 pathname 折叠成 `//evil.com`
  // （浏览器会当作协议相对地址处理），或残留反斜杠，一律拒绝。
  if (path.startsWith('//') || path.includes('\\')) return '/';
  return path;
}
