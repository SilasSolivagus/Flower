import { createHash } from 'node:crypto';

/** 由来源键派生确定性 UUID（位布局同 UUID v5）。同样的 namespace 与 key 永远得到同一个 ID。 */
export function legacyUuid(namespace: string, key: string): string {
  const h = createHash('sha1').update(`flower-legacy:${namespace}:${key}`).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}
