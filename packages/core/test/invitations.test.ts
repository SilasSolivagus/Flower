import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAccount } from '../src/auth/accounts';
import type { Actor } from '../src/domain-types';
import { acceptInvitation, createInvitation, listInvitations, previewInvitation, revokeInvitation } from '../src/tenancy/invitations';
import { createPlaceholderMember, listMembers } from '../src/tenancy/members';
import { listMyOrganizations } from '../src/tenancy/orgs';
import { createTestDb } from './db';
import { seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
});
afterAll(() => t.cleanup());

describe('邀请', () => {
  it('新用户通过邀请注册并加入组织', async () => {
    const { token, invitation } = await createInvitation(t.db, owner, { email: 'New@Example.com', orgRole: 'member' });
    expect(invitation.email).toBe('new@example.com');
    expect(await previewInvitation(t.db, token)).toMatchObject({ orgSlug: 'acme', status: 'pending', accountExists: false });

    const r = await acceptInvitation(t.db, token, { newAccount: { name: '新人', password: 'password123' } });
    expect(r.orgSlug).toBe('acme');
    const orgs = await listMyOrganizations(t.db, r.accountId);
    expect(orgs.map((o) => o.slug)).toEqual(['acme']);
    expect((await previewInvitation(t.db, token))?.status).toBe('accepted');
    await expect(acceptInvitation(t.db, token, { accountId: r.accountId })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('邀请绑定无账号成员，接受后该成员关联账号', async () => {
    const placeholder = await createPlaceholderMember(t.db, owner, { displayName: '王总' });
    const { token } = await createInvitation(t.db, owner, { email: 'wang@example.com', orgRole: 'member', memberId: placeholder.id });
    const r = await acceptInvitation(t.db, token, { newAccount: { name: '王某', password: 'password123' } });
    expect(r.memberId).toBe(placeholder.id);
    const m = (await listMembers(t.db, owner)).find((x) => x.id === placeholder.id);
    expect(m?.hasAccount).toBe(true);
  });

  it('已有账号的用户接受邀请，邮箱必须一致', async () => {
    const acc = await createAccount(t.db, { email: 'exist@example.com', name: '老用户', password: 'password123' });
    const other = await createAccount(t.db, { email: 'other@example.com', name: '别人', password: 'password123' });
    const { token } = await createInvitation(t.db, owner, { email: 'exist@example.com', orgRole: 'guest' });
    expect((await previewInvitation(t.db, token))?.accountExists).toBe(true);
    await expect(acceptInvitation(t.db, token, { accountId: other.id })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(acceptInvitation(t.db, token, { newAccount: { name: 'x', password: 'password123' } })).rejects.toMatchObject({ code: 'conflict' });
    const r = await acceptInvitation(t.db, token, { accountId: acc.id });
    expect((await listMyOrganizations(t.db, acc.id))[0]?.role).toBe('guest');
    expect(r.orgSlug).toBe('acme');
  });

  it('撤销后不能再接受；已是成员的邮箱不能再邀请', async () => {
    const { token, invitation } = await createInvitation(t.db, owner, { email: 'revoked@example.com', orgRole: 'member' });
    await revokeInvitation(t.db, owner, invitation.id);
    expect((await previewInvitation(t.db, token))?.status).toBe('revoked');
    await expect(acceptInvitation(t.db, token, { newAccount: { name: 'x', password: 'password123' } })).rejects.toMatchObject({ code: 'invalid' });
    await expect(createInvitation(t.db, owner, { email: 'owner@example.com', orgRole: 'member' })).rejects.toMatchObject({ code: 'conflict' });
    expect((await listInvitations(t.db, owner)).length).toBeGreaterThanOrEqual(4);
  });

  it('未知令牌返回 null；普通成员不能发邀请', async () => {
    expect(await previewInvitation(t.db, 'nope')).toBeNull();
    await expect(createInvitation(t.db, { ...owner, orgRole: 'member' }, { email: 'a@b.com', orgRole: 'member' })).rejects.toMatchObject({ code: 'forbidden' });
  });
});
