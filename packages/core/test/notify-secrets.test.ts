import { describe, expect, it } from 'vitest';
import { assertSafeOutboundUrl, channelConfigHint, channelPublicSettings, mergeChannelConfig, parseChannelConfig } from '../src/notifications/channel-config';
import { decryptConfig, encryptConfig } from '../src/notifications/secrets';

const KEY = 'unit-test-secret-unit-test-secret-unit-test-secret';
const WECOM_URL = 'https://qyapi.example.com/cgi-bin/webhook/send?key=00000000-aaaa-bbbb-cccc-0000demo1234';
const EMAIL = { host: 'smtp.example.com', port: 465, secure: true, user: 'robot@example.com', pass: 'demo-password-1', from: 'robot@example.com', to: ['pm@example.com'] };

describe('通道配置加密', () => {
  it('往返一致；带 v1 前缀；同一明文两次密文不同；密文里看不到明文', () => {
    const a = encryptConfig({ url: WECOM_URL }, KEY);
    const b = encryptConfig({ url: WECOM_URL }, KEY);
    expect(a).toMatch(/^v1:[\w-]+:[\w-]+:[\w-]+$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain('demo1234');
    expect(decryptConfig(a, KEY)).toEqual({ url: WECOM_URL });
  });

  it('密钥不同、密文被改、版本不认识时报错', () => {
    const token = encryptConfig(EMAIL, KEY);
    expect(() => decryptConfig(token, `${KEY}-other`)).toThrow('通道配置无法解密');
    const [v, iv, tag, ct] = token.split(':');
    // 改第一个字符：它的 6 位全部落在第一个字节里，改动一定生效（末尾字符可能只含填充位）
    const flipped = `${ct![0] === 'A' ? 'B' : 'A'}${ct!.slice(1)}`;
    expect(() => decryptConfig([v, iv, tag, flipped].join(':'), KEY)).toThrow('通道配置无法解密');
    expect(() => decryptConfig(`v9:${iv}:${tag}:${ct}`, KEY)).toThrow('通道配置无法解密');
  });
});

describe('通道配置校验、脱敏与修改', () => {
  it('网址必须是 http(s)；邮件收件人格式；Webhook 空密钥视为没有', () => {
    expect(() => parseChannelConfig('wecom_robot', { url: 'ftp://x.example.com' })).toThrow('通道配置有误');
    expect(() => parseChannelConfig('email', { ...EMAIL, to: ['不是邮箱'] })).toThrow('通道配置有误');
    expect(parseChannelConfig('webhook', { url: 'https://hooks.example.com/in', secret: '' })).toEqual({ url: 'https://hooks.example.com/in' });
  });

  it('脱敏：企微只露 key 末 4 位；Webhook 只露协议与主机，不露路径；邮件不含密码与用户名', () => {
    expect(channelConfigHint('wecom_robot', { url: WECOM_URL })).toBe('…/send?key=****1234');
    expect(channelConfigHint('webhook', { url: 'https://hooks.example.com/in/abcdef9876', secret: 's3cret-value' })).toBe('https://hooks.example.com/**** · 已设置签名密钥');
    expect(channelConfigHint('webhook', { url: 'https://hooks.example.com/in/abcdef9876' })).toBe('https://hooks.example.com/****');
    const hint = channelConfigHint('email', EMAIL);
    expect(hint).toBe('smtp.example.com:465 · robot@example.com → 1 个收件人');
    expect(hint).not.toContain('demo-password-1');
  });

  it('非敏感字段只对邮件返回，且不含密码', () => {
    expect(channelPublicSettings('wecom_robot', { url: WECOM_URL })).toBeNull();
    const s = channelPublicSettings('email', EMAIL);
    expect(s).toEqual({ host: 'smtp.example.com', port: 465, secure: true, user: 'robot@example.com', from: 'robot@example.com', to: ['pm@example.com'] });
    expect(JSON.stringify(s)).not.toContain('demo-password-1');
  });

  it('修改：敏感字段留空表示不变；clearSecret 清除签名密钥；新网址替换', () => {
    expect(mergeChannelConfig('email', EMAIL, { pass: '', host: 'smtp2.example.com' })).toEqual({ ...EMAIL, host: 'smtp2.example.com' });
    expect(mergeChannelConfig('webhook', { url: 'https://hooks.example.com/in', secret: 'old' }, { url: '  ' })).toEqual({ url: 'https://hooks.example.com/in', secret: 'old' });
    expect(mergeChannelConfig('webhook', { url: 'https://hooks.example.com/in', secret: 'old' }, { clearSecret: true })).toEqual({ url: 'https://hooks.example.com/in' });
    expect(mergeChannelConfig('wecom_robot', { url: WECOM_URL }, { url: 'https://qyapi.example.com/cgi-bin/webhook/send?key=new-key-5678' })).toEqual({
      url: 'https://qyapi.example.com/cgi-bin/webhook/send?key=new-key-5678',
    });
  });
});

describe('assertSafeOutboundUrl', () => {
  it('放行公网 http(s) 地址', () => {
    expect(() => assertSafeOutboundUrl('https://hooks.example.com/in')).not.toThrow();
    expect(() => assertSafeOutboundUrl('http://example.com/webhook')).not.toThrow();
  });

  it('拒绝非 http(s) 协议', () => {
    expect(() => assertSafeOutboundUrl('ftp://example.com/x')).toThrow('网址不能指向本机或内网地址');
    expect(() => assertSafeOutboundUrl('not-a-url')).toThrow('网址不能指向本机或内网地址');
  });

  it('拒绝 localhost 与 .local', () => {
    expect(() => assertSafeOutboundUrl('http://localhost/x')).toThrow();
    expect(() => assertSafeOutboundUrl('http://LOCALHOST/x')).toThrow();
    expect(() => assertSafeOutboundUrl('http://printer.local/x')).toThrow();
  });

  it('拒绝 IPv4 环回、链路本地、RFC1918 私有与 CGNAT 地址', () => {
    expect(() => assertSafeOutboundUrl('http://127.0.0.1/x')).toThrow();
    expect(() => assertSafeOutboundUrl('http://127.255.255.255/x')).toThrow();
    expect(() => assertSafeOutboundUrl('http://169.254.1.1/x')).toThrow();
    expect(() => assertSafeOutboundUrl('http://10.0.0.5/x')).toThrow();
    expect(() => assertSafeOutboundUrl('http://172.16.0.1/x')).toThrow();
    expect(() => assertSafeOutboundUrl('http://172.31.255.255/x')).toThrow();
    expect(() => assertSafeOutboundUrl('http://192.168.1.1/x')).toThrow();
    expect(() => assertSafeOutboundUrl('http://100.64.0.1/x')).toThrow();
    expect(() => assertSafeOutboundUrl('http://100.127.255.255/x')).toThrow();
    // 边界之外应放行
    expect(() => assertSafeOutboundUrl('http://172.15.255.255/x')).not.toThrow();
    expect(() => assertSafeOutboundUrl('http://172.32.0.0/x')).not.toThrow();
    expect(() => assertSafeOutboundUrl('http://100.63.255.255/x')).not.toThrow();
    expect(() => assertSafeOutboundUrl('http://100.128.0.0/x')).not.toThrow();
  });

  it('拒绝 IPv6 回环、链路本地与唯一本地地址', () => {
    expect(() => assertSafeOutboundUrl('http://[::1]/x')).toThrow();
    expect(() => assertSafeOutboundUrl('http://[fe80::1]/x')).toThrow();
    expect(() => assertSafeOutboundUrl('http://[fc00::1]/x')).toThrow();
    expect(() => assertSafeOutboundUrl('http://[fd12:3456::1]/x')).toThrow();
    expect(() => assertSafeOutboundUrl('http://[::ffff:127.0.0.1]/x')).toThrow();
    expect(() => assertSafeOutboundUrl('http://[2001:db8::1]/x')).not.toThrow();
  });

  it('FLOWER_NOTIFY_ALLOW_PRIVATE=1 时跳过检查', () => {
    const prev = process.env.FLOWER_NOTIFY_ALLOW_PRIVATE;
    process.env.FLOWER_NOTIFY_ALLOW_PRIVATE = '1';
    try {
      expect(() => assertSafeOutboundUrl('http://127.0.0.1/x')).not.toThrow();
      expect(() => assertSafeOutboundUrl('http://localhost/x')).not.toThrow();
    } finally {
      if (prev === undefined) delete process.env.FLOWER_NOTIFY_ALLOW_PRIVATE;
      else process.env.FLOWER_NOTIFY_ALLOW_PRIVATE = prev;
    }
  });
});
