import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * 本机假企业微信接口：只监听 127.0.0.1。gettoken 只认 opts.secret；getuserinfo 按 users 把授权码换成 userid，
 * 其他授权码报 40029。calls 记下访问过的路径（不记查询参数，里面有密钥）。
 */
export async function startFakeWecom(opts: { secret: string; users: Record<string, string> }): Promise<{ base: string; calls: string[]; close: () => Promise<void> }> {
  const calls: string[] = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    calls.push(u.pathname);
    let body: Record<string, unknown>;
    if (u.pathname === '/cgi-bin/gettoken') {
      body = u.searchParams.get('corpsecret') === opts.secret ? { errcode: 0, errmsg: 'ok', access_token: 'fake-token', expires_in: 7200 } : { errcode: 40001, errmsg: 'invalid credential' };
    } else if (u.pathname === '/cgi-bin/auth/getuserinfo') {
      const userid = u.searchParams.get('access_token') === 'fake-token' ? opts.users[u.searchParams.get('code') ?? ''] : undefined;
      body = userid ? { errcode: 0, errmsg: 'ok', userid } : { errcode: 40029, errmsg: 'invalid code' };
    } else {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, calls, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
