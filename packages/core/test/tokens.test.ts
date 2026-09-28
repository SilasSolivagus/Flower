import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticateToken, issueToken, listTokens, revokeToken } from '../src/access/tokens';
import { apiTokens, domainEvents } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import type { Actor } from '../src/domain-types';
import { createAgentMember, createPlaceholderMember } from '../src/tenancy/members';
import { createProduct } from '../src/tenancy/products';
import { createTestDb } from './db';
import { seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let productId: string;
beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  productId = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
});
afterAll(() => t.cleanup());

describe('API Token', () => {
  it('个人 Token：明文只返回一次，可认证为本人', async () => {
    const { token, record } = await issueToken(t.db, owner, {
      memberId: owner.memberId, name: '本地脚本', scope: { products: 'all', access: 'write' },
    });
    expect(token).toMatch(/^flw_[0-9a-f]{10}_[A-Za-z0-9_-]{43}$/);
    expect(record.prefix).toBe(token.slice(4, 14));
    const auth = await authenticateToken(t.db, token);
    expect(auth).toMatchObject({ orgSlug: 'acme', actor: { memberId: owner.memberId, orgRole: 'owner', tokenId: record.id } });
    expect((await listTokens(t.db, owner)).find((x) => x.id === record.id)?.lastUsedAt).toBeTruthy();
  });

  it('Agent Token：由管理员签发，范围限定到指定产品且只读', async () => {
    const agent = await createAgentMember(t.db, owner, { displayName: 'PRD 助手' });
    const { token } = await issueToken(t.db, owner, {
      memberId: agent.id, name: 'Claude Code', scope: { products: [productId], access: 'read' },
    });
    const auth = await authenticateToken(t.db, token);
    expect(auth?.actor).toMatchObject({ memberId: agent.id, accountId: null, tokenScope: { products: [productId], access: 'read' } });
  });

  it('不能给非 Agent 的其他成员签发；Token 不能再签发 Token', async () => {
    const human = await createPlaceholderMember(t.db, owner, { displayName: '张三' });
    await expect(
      issueToken(t.db, owner, { memberId: human.id, name: 'x', scope: { products: 'all', access: 'read' } }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const viaToken: Actor = { ...owner, tokenId: 'some-token', tokenScope: { products: 'all', access: 'write' } };
    await expect(
      issueToken(t.db, viaToken, { memberId: owner.memberId, name: 'x', scope: { products: 'all', access: 'read' } }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('范围里的产品必须存在', async () => {
    await expect(
      issueToken(t.db, owner, { memberId: owner.memberId, name: 'x', scope: { products: ['00000000-0000-7000-8000-000000000000'], access: 'read' } }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('撤销、过期、格式错误的 Token 无法认证', async () => {
    const a = await issueToken(t.db, owner, { memberId: owner.memberId, name: '将撤销', scope: { products: 'all', access: 'read' } });
    await revokeToken(t.db, owner, a.record.id);
    expect(await authenticateToken(t.db, a.token)).toBeNull();

    const b = await issueToken(t.db, owner, {
      memberId: owner.memberId, name: '已过期', scope: { products: 'all', access: 'read' }, expiresAt: new Date(Date.now() + 60_000),
    });
    // issueToken 拒绝过去的过期时间，这里直接改库模拟"已经过期"的既有 Token。
    await withOrg(t.db, owner.orgId, (tx) => tx.update(apiTokens).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(apiTokens.id, b.record.id)));
    expect(await authenticateToken(t.db, b.token)).toBeNull();

    expect(await authenticateToken(t.db, 'flw_bad')).toBeNull();
    const tampered = `${a.token.slice(0, -1)}${a.token.endsWith('A') ? 'B' : 'A'}`;
    expect(await authenticateToken(t.db, tampered)).toBeNull();
  });

  it('过期时间必须晚于当前时间', async () => {
    await expect(
      issueToken(t.db, owner, {
        memberId: owner.memberId, name: '过去的时间', scope: { products: 'all', access: 'read' }, expiresAt: new Date(Date.now() - 1000),
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('撤销已撤销的 Token 是空操作：不再次记录事件，revokedAt 不变', async () => {
    const { record } = await issueToken(t.db, owner, { memberId: owner.memberId, name: '将两次撤销', scope: { products: 'all', access: 'read' } });
    await revokeToken(t.db, owner, record.id);
    const firstRevokedAt = (await listTokens(t.db, owner)).find((x) => x.id === record.id)?.revokedAt;
    expect(firstRevokedAt).toBeTruthy();
    await revokeToken(t.db, owner, record.id);
    const secondRevokedAt = (await listTokens(t.db, owner)).find((x) => x.id === record.id)?.revokedAt;
    expect(secondRevokedAt?.getTime()).toBe(firstRevokedAt?.getTime());
    const events = await withOrg(t.db, owner.orgId, (tx) =>
      tx.select().from(domainEvents).where(and(eq(domainEvents.subjectId, record.id), eq(domainEvents.type, 'api_token.revoked'))),
    );
    expect(events).toHaveLength(1);
  });
});
