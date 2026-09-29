import { describe, expect, it } from 'vitest';
import { computeChecklist } from './checklist';

const base = { members: [], invitations: [], products: [], workflows: [], fields: [], tokens: [] };
const member = (over: Record<string, unknown>) =>
  ({ id: 'm', kind: 'human', displayName: 'x', email: null, department: null, orgRole: 'member', status: 'active', hasAccount: true, functionTagIds: [], productRoles: [], ...over }) as never;

describe('computeChecklist', () => {
  it('新组织全部未完成，且顺序固定', () => {
    const items = computeChecklist('acme', base);
    expect(items.map((i) => [i.key, i.done])).toEqual([
      ['invite', false],
      ['tags', false],
      ['product', false],
      ['workflow', false],
      ['fields', false],
      ['agent', false],
    ]);
    expect(items[0]!.href).toBe('/acme/settings/members');
  });

  it('按实际数据判断完成', () => {
    const items = computeChecklist('acme', {
      members: [member({ id: '1' }), member({ id: '2', functionTagIds: ['t'] }), member({ id: '3', kind: 'agent', hasAccount: false })],
      invitations: [],
      products: [{ id: 'p' }] as never,
      workflows: [{ id: 'w', currentVersion: 2, productId: null }] as never,
      fields: [{ key: 'platform', options: [{ id: 'o' }] }] as never,
      tokens: [{ id: 't', memberId: '3', revokedAt: null }] as never,
    });
    expect(items.every((i) => i.done)).toBe(true);
  });

  it('只有待接受的邀请也算完成"邀请成员"', () => {
    const items = computeChecklist('acme', { ...base, invitations: [{ id: 'i', acceptedAt: null, revokedAt: null }] as never });
    expect(items.find((i) => i.key === 'invite')!.done).toBe(true);
  });
});
