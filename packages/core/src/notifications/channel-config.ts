import { z } from 'zod';
import { AppError } from '../errors';
import type { ChannelKind } from './constants';

export type WecomConfig = { url: string };
export type WebhookConfig = { url: string; secret?: string };
export type EmailConfig = { host: string; port: number; secure: boolean; user: string; pass: string; from: string; to: string[] };
export type ChannelConfig = WecomConfig | WebhookConfig | EmailConfig;

/** 修改通道时提交的配置：敏感字段（网址、签名密钥、邮箱密码）留空表示不变；clearSecret 清除 Webhook 签名密钥。 */
export type ChannelConfigPatch = {
  url?: string;
  secret?: string;
  clearSecret?: boolean;
  host?: string;
  port?: number;
  secure?: boolean;
  user?: string;
  pass?: string;
  from?: string;
  to?: string[];
};

/** 接口返回的非敏感配置：只有邮件通道有，供修改表单回填；网址、签名密钥、密码一律不返回。 */
export type ChannelPublicSettings = { host: string; port: number; secure: boolean; user: string; from: string; to: string[] } | null;

const httpUrl = z
  .string()
  .trim()
  .max(2000, '网址太长')
  .refine((v) => {
    const u = URL.parse(v);
    return !!u && (u.protocol === 'https:' || u.protocol === 'http:');
  }, '网址应以 http:// 或 https:// 开头');
const email = z.string().trim().max(255).regex(/^[^\s@]+@[^\s@]+$/, '邮箱地址格式不正确');

const SCHEMAS = {
  wecom_robot: z.object({ url: httpUrl }),
  webhook: z.object({ url: httpUrl, secret: z.string().max(200, '签名密钥太长').optional() }),
  email: z.object({
    host: z.string().trim().min(1, '请填写 SMTP 服务器').max(255),
    port: z.number().int().min(1).max(65535),
    secure: z.boolean(),
    user: z.string().trim().min(1, '请填写用户名').max(255),
    pass: z.string().min(1, '请填写密码').max(500),
    from: email,
    to: z.array(email).min(1, '至少一个收件人').max(50, '收件人最多 50 个'),
  }),
};

export function parseChannelConfig(kind: ChannelKind, raw: unknown): ChannelConfig {
  const r = SCHEMAS[kind].safeParse(raw);
  if (!r.success) {
    throw new AppError('invalid', '通道配置有误', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  if (kind === 'wecom_robot') {
    const { url } = r.data as WecomConfig;
    assertSafeOutboundUrl(url);
    return { url };
  }
  if (kind === 'webhook') {
    const { url, secret } = r.data as WebhookConfig;
    assertSafeOutboundUrl(url);
    return secret ? { url, secret } : { url };
  }
  const config = r.data as EmailConfig;
  assertSafeOutboundHost(config.host, 'SMTP 服务器不能是本机或内网地址');
  return config;
}

const filled = (v: string | undefined): string | undefined => (v === undefined || v.trim() === '' ? undefined : v);

export function mergeChannelConfig(kind: ChannelKind, current: ChannelConfig, patch: ChannelConfigPatch): ChannelConfig {
  if (kind === 'wecom_robot') return parseChannelConfig(kind, { url: filled(patch.url) ?? (current as WecomConfig).url });
  if (kind === 'webhook') {
    const c = current as WebhookConfig;
    return parseChannelConfig(kind, { url: filled(patch.url) ?? c.url, secret: patch.clearSecret ? undefined : (filled(patch.secret) ?? c.secret) });
  }
  const c = current as EmailConfig;
  return parseChannelConfig(kind, {
    host: patch.host ?? c.host,
    port: patch.port ?? c.port,
    secure: patch.secure ?? c.secure,
    user: patch.user ?? c.user,
    pass: filled(patch.pass) ?? c.pass,
    from: patch.from ?? c.from,
    to: patch.to ?? c.to,
  });
}

const tail = (s: string): string => `****${s.slice(-4)}`;

/** 企微机器人脱敏：网址的 `key` 查询参数只露末 4 位；没有 `key` 时整个网址只露末 4 位。 */
function maskWecomUrl(raw: string): string {
  const u = new URL(raw);
  const key = u.searchParams.get('key');
  if (key) return `…/${u.pathname.split('/').filter(Boolean).at(-1) ?? ''}?key=${tail(key)}`;
  return `${u.protocol}//${u.host}/…${tail(raw)}`;
}

/** Webhook 脱敏：只露协议与主机，路径与查询整段打码（不像企微那样露出末 4 位，因为 Webhook 的密钥多半在签名密钥里而不是网址上）。 */
function maskWebhookUrl(raw: string): string {
  const u = new URL(raw);
  return `${u.protocol}//${u.host}/****`;
}

/** 脱敏展示文本：不含网址中的密钥、签名密钥、邮箱用户名与密码。 */
export function channelConfigHint(kind: ChannelKind, config: ChannelConfig): string {
  if (kind === 'wecom_robot') return maskWecomUrl((config as WecomConfig).url);
  if (kind === 'webhook') {
    const c = config as WebhookConfig;
    return `${maskWebhookUrl(c.url)}${c.secret ? ' · 已设置签名密钥' : ''}`;
  }
  const c = config as EmailConfig;
  return `${c.host}:${c.port} · ${c.from} → ${c.to.length} 个收件人`;
}

export function channelPublicSettings(kind: ChannelKind, config: ChannelConfig): ChannelPublicSettings {
  if (kind !== 'email') return null;
  const { host, port, secure, user, from, to } = config as EmailConfig;
  return { host, port, secure, user, from, to };
}

/** 环回地址 127.0.0.0/8，以及未指定地址 0.0.0.0/8（Linux、macOS 上都会连到本机）。 */
const isLoopbackV4 = (a: number): boolean => a === 127 || a === 0;
/** RFC1918 私有地址。 */
const isPrivateV4 = (a: number, b: number): boolean => a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
/** 链路本地地址 169.254.0.0/16。 */
const isLinkLocalV4 = (a: number, b: number): boolean => a === 169 && b === 254;
/** 运营商级 NAT 地址 100.64.0.0/10。 */
const isCgnatV4 = (a: number, b: number): boolean => a === 100 && b >= 64 && b <= 127;

function isUnsafeIpv4(hostname: string): boolean | undefined {
  const m = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return undefined;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return isLoopbackV4(a) || isPrivateV4(a, b) || isLinkLocalV4(a, b) || isCgnatV4(a, b);
}

/** 把压缩写法（`::`）展开成 8 个 16 位分组；格式不对返回 undefined。 */
function expandIpv6(h: string): number[] | undefined {
  const parts = h.split('::');
  if (parts.length > 2) return undefined;
  const parseGroups = (s: string): number[] | undefined => {
    if (s === '') return [];
    const nums = s.split(':').map((g) => Number.parseInt(g, 16));
    return nums.some((n) => Number.isNaN(n)) ? undefined : nums;
  };
  const head = parseGroups(parts[0] ?? '');
  const tail = parts.length === 2 ? parseGroups(parts[1] ?? '') : [];
  if (!head || !tail) return undefined;
  if (parts.length === 1) return head.length === 8 ? head : undefined;
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return undefined;
  return [...head, ...Array(missing).fill(0), ...tail];
}

/** IPv6 字面量（hostname 带中括号）是否为回环 `::1`、未指定地址 `::`、链路本地 `fe80::/10`、唯一本地 `fc00::/7`，或映射到不安全 IPv4 地址的 `::ffff:a.b.c.d`。 */
function isUnsafeIpv6(bracketed: string): boolean | undefined {
  if (!bracketed.startsWith('[') || !bracketed.endsWith(']')) return undefined;
  const groups = expandIpv6(bracketed.slice(1, -1).toLowerCase());
  if (!groups) return false;
  const [g0, , , , , g5, g6, g7] = groups;
  if (groups.every((n) => n === 0)) return true; // ::（未指定地址，本机会当作本地连接）
  if (groups.slice(0, 7).every((n) => n === 0) && g7 === 1) return true; // ::1
  if (groups.slice(0, 5).every((n) => n === 0) && g5 === 0xffff) {
    const a = (g6! >> 8) & 0xff;
    const b = g6! & 0xff;
    return isLoopbackV4(a) || isPrivateV4(a, b) || isLinkLocalV4(a, b) || isCgnatV4(a, b);
  }
  if (g0! >= 0xfe80 && g0! <= 0xfebf) return true; // fe80::/10
  if (g0! >= 0xfc00 && g0! <= 0xfdff) return true; // fc00::/7
  return false;
}

/**
 * 只做主机名/字面量检查，不做 DNS 解析：公网域名即便实际解析到内网地址也不会被拦住。
 * 真正杜绝 DNS rebinding 需要在发送时对已解析的 IP 再次校验，本函数只覆盖保存与发送前的静态检查。
 *
 * hostname 既接受 URL 的 `hostname`（IPv6 带中括号，如 `[::1]`），也接受裸主机名（如 SMTP 的 `host`，
 * IPv6 字面量不带中括号，如 `::1`）——按是否已带中括号自行判断。
 */
export function assertSafeOutboundHost(hostname: string, message = '网址不能指向本机或内网地址'): void {
  if (process.env.FLOWER_NOTIFY_ALLOW_PRIVATE === '1') return;
  // 域名末尾的 `.`（如 `localhost.`）解析器会当作没有这个点，去掉后再比较
  const h = hostname.toLowerCase().replace(/\.$/, '');
  const bracketed = h.startsWith('[') || !h.includes(':') ? h : `[${h}]`;
  if (h === 'localhost' || h.endsWith('.local') || isUnsafeIpv4(h) || isUnsafeIpv6(bracketed)) {
    throw new AppError('invalid', message);
  }
}

export function assertSafeOutboundUrl(raw: string): void {
  if (process.env.FLOWER_NOTIFY_ALLOW_PRIVATE === '1') return;
  const fail = () => new AppError('invalid', '网址不能指向本机或内网地址');
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw fail();
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw fail();
  assertSafeOutboundHost(u.hostname);
}
