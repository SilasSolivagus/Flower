import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultTransport, sendPayload } from '../src/notifications/sender';

const json = { type: 'json' as const, body: { msgtype: 'text', text: { content: 'hi' } } };
const smtp = { host: 'localhost', port: 25, secure: false, user: 'u', pass: 'p', from: 'a@example.com', to: ['b@example.com'] };

describe('默认发送器：连接时检查解析出的地址', () => {
  afterEach(() => {
    delete process.env.FLOWER_NOTIFY_ALLOW_PRIVATE;
  });

  it('域名解析到本机或内网地址时拒绝连接（保存时的字面量检查拦不住这种情况）', async () => {
    // 直接调用发送器、绕过 sendPayload 的字面量检查，模拟「公网域名解析到内网」
    await expect(defaultTransport.postJson('http://localhost:9/hook', '{}', {})).rejects.toThrow('网址不能指向本机或内网地址');
    await expect(defaultTransport.sendMail(smtp, { subject: 's', text: 't' })).rejects.toThrow('SMTP 服务器不能是本机或内网地址');
  });

  it('允许内网时照常发送，并返回状态码与响应体；不跟随重定向', async () => {
    process.env.FLOWER_NOTIFY_ALLOW_PRIVATE = '1';
    const received: { headers: http.IncomingHttpHeaders; body: string }[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        if (req.url === '/redirect') {
          res.writeHead(302, { location: 'http://localhost/elsewhere' }).end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"errcode":0}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      expect(await sendPayload('wecom_robot', { url: `http://localhost:${port}/send?key=k` }, json, defaultTransport, new Date())).toEqual({
        result: 'sent',
        response: 'HTTP 200 {"errcode":0}',
      });
      expect(received[0]!.headers['content-type']).toBe('application/json');
      expect(JSON.parse(received[0]!.body)).toEqual(json.body);
      expect(await sendPayload('webhook', { url: `http://localhost:${port}/redirect` }, json, defaultTransport, new Date())).toEqual({ result: 'failed', response: 'HTTP 302' });
      expect(received).toHaveLength(2);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
