import { createHmac } from 'node:crypto';
import dns, { type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import nodemailer from 'nodemailer';
import { assertSafeOutboundHost, assertSafeOutboundUrl, type ChannelConfig, type EmailConfig, type WebhookConfig, type WecomConfig } from './channel-config';
import { type ChannelKind, type ChannelPayload, MAX_ATTEMPTS, RESPONSE_MAX_CHARS, RETRY_DELAYS_SECONDS } from './constants';

export type HttpResult = { status: number; text: string };
export type Transport = {
  postJson(url: string, body: string, headers: Record<string, string>): Promise<HttpResult>;
  sendMail(config: EmailConfig, message: { subject: string; text: string; to?: string[] }): Promise<string>;
};
/** 后台发送与测试消息需要的依赖：实例密钥（解密配置）、对外网址（消息里的链接）、发送器。 */
export type NotifyDeps = { secretKey: string; publicUrl: string; transport: Transport };

/** 响应体最多读取的字节数：只用于记录（截到 RESPONSE_MAX_CHARS）和解析企微 errcode。 */
const MAX_RESPONSE_BYTES = 64 * 1024;

/** 解析主机名并检查全部地址：保存时只做了字面量检查，公网域名可能解析到内网地址（含 DNS rebinding）。 */
function lookupSafe(hostname: string, message: string): Promise<LookupAddress[]> {
  return new Promise((resolve, reject) => {
    dns.lookup(hostname, { all: true }, (err, addresses) => {
      if (err) return reject(err);
      try {
        for (const a of addresses) assertSafeOutboundHost(a.address, message);
      } catch (e) {
        return reject(e);
      }
      resolve(addresses);
    });
  });
}

/** 给 http(s).request 用的 lookup：连接用的就是检查过的地址，不会在检查与连接之间被换掉。 */
const safeLookup: LookupFunction = (hostname, options, callback) => {
  lookupSafe(hostname, '网址不能指向本机或内网地址').then(
    (addresses) => {
      if (options.all) return (callback as (err: null, addresses: LookupAddress[]) => void)(null, addresses);
      const first = addresses.find((a) => !options.family || a.family === options.family) ?? addresses[0];
      if (!first) return callback(Object.assign(new Error(`无法解析 ${hostname}`), { code: 'ENOTFOUND' }), '', 0);
      callback(null, first.address, first.family);
    },
    (e: NodeJS.ErrnoException) => callback(e, '', 0),
  );
};

export const defaultTransport: Transport = {
  postJson(url, body, headers) {
    const u = new URL(url);
    const request = u.protocol === 'https:' ? https.request : http.request;
    return new Promise<HttpResult>((resolve, reject) => {
      // 不跟随重定向（http.request 本身不跟随），3xx 按失败处理
      const req = request(
        u,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers },
          lookup: safeLookup,
          signal: AbortSignal.timeout(10_000),
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (c: Buffer) => {
            if (size >= MAX_RESPONSE_BYTES) return;
            chunks.push(c);
            size += c.length;
          });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).subarray(0, MAX_RESPONSE_BYTES).toString('utf8') }));
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  },
  async sendMail(cfg, msg) {
    // 先解析并检查 SMTP 服务器地址，再直连检查过的 IP；TLS 仍按原主机名校验证书
    const [addr] = await lookupSafe(cfg.host, 'SMTP 服务器不能是本机或内网地址');
    const transporter = nodemailer.createTransport({
      host: addr!.address,
      servername: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: { user: cfg.user, pass: cfg.pass },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
    const info = await transporter.sendMail({ from: cfg.from, to: msg.to ?? cfg.to, subject: msg.subject, text: msg.text });
    return `SMTP 已接受 ${info.accepted.length} 个收件人`;
  },
};

export type SendOutcome = { result: 'sent' | 'failed' | 'rate_limited'; response: string };

/** 企微机器人「接口调用超过限制」。 */
const WECOM_RATE_LIMITED = 45009;

export function classifyHttp(kind: 'wecom_robot' | 'webhook', res: HttpResult): SendOutcome {
  const response = `HTTP ${res.status} ${res.text}`.trim().slice(0, RESPONSE_MAX_CHARS);
  if (res.status === 429) return { result: 'rate_limited', response };
  if (res.status < 200 || res.status >= 300) return { result: 'failed', response };
  if (kind === 'webhook') return { result: 'sent', response };
  let errcode: unknown;
  try {
    errcode = (JSON.parse(res.text) as { errcode?: unknown }).errcode;
  } catch {
    return { result: 'failed', response };
  }
  if (errcode === 0) return { result: 'sent', response };
  if (errcode === WECOM_RATE_LIMITED) return { result: 'rate_limited', response };
  return { result: 'failed', response };
}

/** Webhook 签名：sha256={HMAC-SHA256(secret, "{timestamp}.{body}") 的十六进制}。 */
export function signWebhook(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

const errorText = (e: unknown): string => {
  // 系统错误码（ECONNREFUSED 等）可能在错误本身（http 模块），也可能在 cause 上（fetch）；AppError 的 code 不是系统错误码
  const own = (e as NodeJS.ErrnoException | undefined)?.code;
  const code = e instanceof Error ? (typeof own === 'string' && /^E[A-Z_]+$/.test(own) ? own : (e.cause as { code?: string } | undefined)?.code) : undefined;
  const message = e instanceof Error ? e.message : String(e);
  return (code && !message.includes(code) ? `${message}：${code}` : message).slice(0, RESPONSE_MAX_CHARS);
};

/**
 * 发送一条请求体。发送前重新检查网址与 SMTP 服务器不指向本机或内网（保存的配置可能早于该检查，
 * 或检查规则有过调整）；被拦下的按失败处理，原因写入 response。
 */
export async function sendPayload(kind: ChannelKind, config: ChannelConfig, payload: ChannelPayload, transport: Transport, now: Date): Promise<SendOutcome> {
  try {
    if (kind === 'email') {
      if (payload.type !== 'email') return { result: 'failed', response: '请求体与通道类型不符' };
      assertSafeOutboundHost((config as EmailConfig).host, 'SMTP 服务器不能是本机或内网地址');
      return {
        result: 'sent',
        response: (await transport.sendMail(config as EmailConfig, { subject: payload.subject, text: payload.text, to: payload.to })).slice(0, RESPONSE_MAX_CHARS),
      };
    }
    if (payload.type !== 'json') return { result: 'failed', response: '请求体与通道类型不符' };
    const url = (config as WecomConfig).url;
    assertSafeOutboundUrl(url);
    const body = JSON.stringify(payload.body);
    const headers: Record<string, string> = {};
    const secret = kind === 'webhook' ? (config as WebhookConfig).secret : undefined;
    if (secret) {
      const timestamp = String(Math.floor(now.getTime() / 1000));
      headers['x-flower-timestamp'] = timestamp;
      headers['x-flower-signature'] = signWebhook(secret, timestamp, body);
    }
    return classifyHttp(kind, await transport.postJson(url, body, headers));
  } catch (e) {
    return { result: 'failed', response: errorText(e) };
  }
}

/** 第 attempts 次失败之后等待的毫秒数；达到上限返回 null（放弃）。 */
export function retryDelayMs(attempts: number): number | null {
  if (attempts >= MAX_ATTEMPTS) return null;
  return RETRY_DELAYS_SECONDS[Math.max(0, attempts - 1)]! * 1000;
}
