import http from 'node:http';
import type { AddressInfo } from 'node:net';

export type Received = { path: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> };

/** 本机假 webhook 接收端：只监听 127.0.0.1，记录收到的请求；reply 设定应答（默认企微成功）。接口测试与端到端共用。 */
export async function startFakeWebhook(): Promise<{
  url: (key: string) => string;
  received: Received[];
  reply: (status: number, body: unknown) => void;
  close: () => Promise<void>;
}> {
  const received: Received[] = [];
  let response: { status: number; body: unknown } = { status: 200, body: { errcode: 0, errmsg: 'ok' } };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      received.push({ path: req.url ?? '', headers: req.headers, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} });
      res.writeHead(response.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(response.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: (key) => `http://127.0.0.1:${port}/cgi-bin/webhook/send?key=${key}`,
    received,
    reply: (status, body) => {
      response = { status, body };
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
