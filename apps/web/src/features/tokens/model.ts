import type { Product, Token, TokenScope } from '@/lib/types';

export function describeScope(scope: TokenScope, products: Product[]): string {
  const target =
    scope.products === 'all' ? '全部产品' : scope.products.map((id) => products.find((p) => p.id === id)?.key ?? '已删除的产品').join('、');
  return `${target} · ${scope.access === 'read' ? '只读' : '读写'}`;
}

export function tokenStatus(t: Token, now: Date = new Date()): 'active' | 'revoked' | 'expired' {
  if (t.revokedAt) return 'revoked';
  if (t.expiresAt && new Date(t.expiresAt).getTime() <= now.getTime()) return 'expired';
  return 'active';
}

const DAYS = { '30d': 30, '90d': 90, '365d': 365 } as const;

export function expiryFromChoice(choice: '30d' | '90d' | '365d' | 'never', now: Date = new Date()): string | null {
  if (choice === 'never') return null;
  return new Date(now.getTime() + DAYS[choice] * 86_400_000).toISOString();
}
