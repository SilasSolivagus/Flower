import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { AppError } from '../errors';

const VERSION = 'v1';
const SALT = 'flower/notification-config';
const INFO = 'aes-256-gcm/v1';

/** 由实例密钥派生通道配置的加密密钥（HKDF-SHA256，32 字节）。 */
function deriveKey(secretKey: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secretKey, SALT, INFO, 32));
}

/** AES-256-GCM 加密，存为 `v1:{iv}:{tag}:{密文}`（base64url）；每次随机 IV。 */
export function encryptConfig(plain: unknown, secretKey: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(secretKey), iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(plain), 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join(':');
}

export function decryptConfig<T>(token: string, secretKey: string): T {
  const [version, iv, tag, ct] = token.split(':');
  const fail = () => new AppError('precondition_failed', '通道配置无法解密：FLOWER_SECRET_KEY 与加密时不同，或数据已损坏');
  if (version !== VERSION || !iv || !tag || ct === undefined) throw fail();
  const ivBuf = Buffer.from(iv, 'base64url');
  const tagBuf = Buffer.from(tag, 'base64url');
  // 长度必须等于加密时写入的 12 字节 IV、16 字节认证标签；截断的标签会让伪造密文的难度从 2^128 降到可行范围
  if (ivBuf.length !== 12 || tagBuf.length !== 16) throw fail();
  try {
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(secretKey), ivBuf, { authTagLength: 16 });
    decipher.setAuthTag(tagBuf);
    const plain = Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
    return JSON.parse(plain) as T;
  } catch {
    throw fail();
  }
}
