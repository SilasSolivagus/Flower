import { describe, expect, it } from 'vitest';
import type { Product, Token } from '@/lib/types';
import { describeScope, expiryFromChoice, tokenStatus } from './model';

const products = [{ id: 'p1', key: 'PAN', name: '网盘' }, { id: 'p2', key: 'VIP', name: '会员' }] as Product[];

describe('Token 展示', () => {
  it('描述范围', () => {
    expect(describeScope({ products: 'all', access: 'write' }, products)).toBe('全部产品 · 读写');
    expect(describeScope({ products: ['p1'], access: 'read' }, products)).toBe('PAN · 只读');
    expect(describeScope({ products: ['p1', 'gone'], access: 'read' }, products)).toBe('PAN、已删除的产品 · 只读');
  });
  it('状态', () => {
    const t = { revokedAt: null, expiresAt: null } as Token;
    expect(tokenStatus(t)).toBe('active');
    expect(tokenStatus({ ...t, revokedAt: '2026-01-01T00:00:00Z' })).toBe('revoked');
    expect(tokenStatus({ ...t, expiresAt: '2020-01-01T00:00:00Z' })).toBe('expired');
  });
  it('有效期选项', () => {
    const now = new Date('2026-09-29T00:00:00Z');
    expect(expiryFromChoice('30d', now)).toBe('2026-10-29T00:00:00.000Z');
    expect(expiryFromChoice('never', now)).toBeNull();
  });
});
