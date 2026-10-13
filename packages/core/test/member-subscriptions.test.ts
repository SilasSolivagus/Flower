import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { domainEvents, subscriptions } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import type { Actor } from '../src/domain-types';
import { autoSubscribeTx, getSubscription, setSubscription } from '../src/member-notifications/subscriptions';
import { addRequirementComment } from '../src/requirements/comments';
import { addRequirementAssignment } from '../src/requirements/assignments';
import { createRequirement } from '../src/requirements/requirements';
import { listFunctionTags } from '../src/tenancy/function-tags';
import { updateMember } from '../src/tenancy/members';
import { createProduct } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, readOnlyToken, seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let a: Actor;
let productId: string;
let reqId: string;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  productId = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  a = await asMember(t.db, owner, '张三');
  reqId = (await createRequirement(t.db, owner, productId, { title: '登录页改版' })).id;
});
afterAll(() => t.cleanup());

const subject = () => ({ type: 'requirement' as const, id: reqId });

describe('关注', () => {
  it('默认未关注；手动关注与取消关注，记事件', async () => {
    expect(await getSubscription(t.db, a, subject())).toEqual({ following: false, source: null, reason: null });
    expect(await setSubscription(t.db, a, subject(), true)).toEqual({ following: true, source: 'manual', reason: '你手动关注了' });
    const off = await setSubscription(t.db, a, subject(), false);
    expect(off.following).toBe(false);
    const types = (await t.adminDb.select({ type: domainEvents.type }).from(domainEvents).where(eq(domainEvents.subjectId, reqId))).map((r) => r.type);
    expect(types).toEqual(expect.arrayContaining(['subscription.followed', 'subscription.unfollowed']));
  });

  it('取消关注后，自动关注不会加回；手动关注可以恢复', async () => {
    await withOrg(t.db, owner.orgId, (tx) => autoSubscribeTx(tx, owner.orgId, subject(), [a.memberId]));
    expect((await getSubscription(t.db, a, subject())).following).toBe(false);
    expect((await setSubscription(t.db, a, subject(), true)).following).toBe(true);
  });

  it('自动关注的原因：负责人、被分配、评论过，其他为兜底说明', async () => {
    const b = await asMember(t.db, owner, '李四');
    const r = await createRequirement(t.db, owner, productId, { title: '分享页', ownerMemberId: b.memberId });
    const s = { type: 'requirement' as const, id: r.id };
    await withOrg(t.db, owner.orgId, (tx) => autoSubscribeTx(tx, owner.orgId, s, [b.memberId, b.memberId, a.memberId]));
    expect(await getSubscription(t.db, b, s)).toEqual({ following: true, source: 'auto', reason: '你是负责人' });
    expect((await getSubscription(t.db, a, s)).reason).toBe('你曾负责、被分配、评论或被 @');
    const tag = (await listFunctionTags(t.db, owner))[0]!;
    await addRequirementAssignment(t.db, owner, r.id, { memberId: a.memberId, functionTagId: tag.id });
    expect((await getSubscription(t.db, a, s)).reason).toBe('你被分配到这条需求');
    const c = await asMember(t.db, owner, '王五');
    await addRequirementComment(t.db, c, r.id, { body: '我来看看' });
    await withOrg(t.db, owner.orgId, (tx) => autoSubscribeTx(tx, owner.orgId, s, [c.memberId]));
    expect((await getSubscription(t.db, c, s)).reason).toBe('你评论过');
    const rows = await t.adminDb.select().from(subscriptions).where(and(eq(subscriptions.subjectId, r.id), eq(subscriptions.memberId, b.memberId)));
    expect(rows).toHaveLength(1);
  });

  it('只读 Token 不能修改；看不到产品的成员报不存在', async () => {
    await expect(setSubscription(t.db, readOnlyToken(owner), subject(), true)).rejects.toThrow('只读 Token 不能修改关注');
    const guest = await asMember(t.db, owner, '访客');
    await updateMember(t.db, owner, guest.memberId, { orgRole: 'guest' });
    await expect(getSubscription(t.db, { ...guest, orgRole: 'guest' }, subject())).rejects.toThrow('产品不存在');
  });
});
