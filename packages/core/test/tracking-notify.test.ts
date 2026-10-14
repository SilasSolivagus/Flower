import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { memberNotifications, subscriptions } from '../src/db/schema';
import type { Actor } from '../src/domain-types';
import { mentionMarkup } from '../src/links/syntax';
import { getSubscription, setSubscription } from '../src/member-notifications/subscriptions';
import { runNotificationTick } from '../src/notifications/worker';
import { createRequirement } from '../src/requirements/requirements';
import { updateMember } from '../src/tenancy/members';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createProgress, type ProgressSubject, updateProgress } from '../src/tracking/progress';
import { createWorkItem, updateWorkItem } from '../src/tracking/work-items';
import { listMentionMembers } from '../src/wecom/accounts';
import { createTestDb } from './db';
import { applyTrackingWorkflow, asMember, seedInstance } from './factories';
import { TEST_DEPS } from './notify-helpers';
import { fakeTransport } from './notify-transport';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let a: Actor;
let b: Actor;
let guest: Actor;
let outsider: Actor;
let leaver: Actor;
let pan: string;
let reqId: string;
const deps = { ...TEST_DEPS, transport: fakeTransport().transport };
const tick = () => runNotificationTick(t.db, deps);
const inbox = (memberId: string) =>
  t.adminDb.select().from(memberNotifications).where(eq(memberNotifications.memberId, memberId)).orderBy(asc(memberNotifications.createdAt), asc(memberNotifications.id));
const last = async (memberId: string) => (await inbox(memberId)).at(-1);
const req = (id: string): ProgressSubject => ({ type: 'requirement', id });
const wi = (id: string): ProgressSubject => ({ type: 'work_item', id });

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  await applyTrackingWorkflow(t.db, owner, pan);
  a = await asMember(t.db, owner, '张三');
  b = await asMember(t.db, owner, '李四');
  // 访客：对网盘有只读角色；外部访客：没有任何产品角色
  guest = await asMember(t.db, owner, '访客', 'guest');
  await updateMember(t.db, owner, guest.memberId, { orgRole: 'guest' });
  await setProductRole(t.db, owner, pan, guest.memberId, 'viewer');
  outsider = await asMember(t.db, owner, '外部访客', 'guest');
  await updateMember(t.db, owner, outsider.memberId, { orgRole: 'guest' });
  leaver = await asMember(t.db, owner, '王五');
  reqId = (await createRequirement(t.db, owner, pan, { title: '登录页改版' })).id;
  await tick();
});
afterAll(() => t.cleanup());

describe('工作项通知', () => {
  it('负责人收到「被指派」并自动关注；描述里的 @ 收到「被 @」；不关联产品时访客收不到', async () => {
    const w = await createWorkItem(t.db, owner, {
      title: '协助排查',
      ownerMemberId: a.memberId,
      description: `${mentionMarkup(b.memberId, '李四')} ${mentionMarkup(guest.memberId, '访客')} 一起看`,
    });
    await tick();
    expect((await inbox(a.memberId)).map((n) => [n.kind, n.subjectType, n.subjectId, n.title, n.body, n.url])).toEqual([
      ['assigned', 'work_item', w.id, 'W-1 协助排查', '把工作项指派给你', '/acme/work-items/W-1'],
    ]);
    expect((await inbox(b.memberId)).map((n) => [n.kind, n.body])).toEqual([['mentioned', '在工作项描述中 @ 了你']]);
    expect(await inbox(guest.memberId)).toEqual([]);
    const subs = await t.adminDb.select().from(subscriptions).where(eq(subscriptions.subjectId, w.id));
    expect(subs.map((s) => [s.memberId, s.subjectType, s.source]).sort()).toEqual(
      [
        [a.memberId, 'work_item', 'auto'],
        [b.memberId, 'work_item', 'auto'],
      ].sort(),
    );
  });

  it('更换负责人：新负责人收到「被指派」', async () => {
    const w = await createWorkItem(t.db, owner, { title: '对接渠道' });
    await updateWorkItem(t.db, owner, w.id, { ownerMemberId: b.memberId });
    await tick();
    expect(await last(b.memberId)).toMatchObject({ kind: 'assigned', title: 'W-2 对接渠道', body: '把工作项指派给你' });
  });
});

describe('进展记录通知', () => {
  it('跟进人收到「你是下一步跟进人」；关注者收到「写了进展」；写的人自己不收', async () => {
    await setSubscription(t.db, b, { type: 'requirement', id: reqId }, true);
    // 每条之后各跑一轮：同一轮写入的通知时间相同，分开跑才能按时间断言顺序
    await createProgress(t.db, owner, req(reqId), { body: '接口已联调完成，等待测试环境部署后验证', nextStep: '部署测试环境', followerMemberId: a.memberId });
    await tick();
    await createProgress(t.db, owner, req(reqId), { body: '补充说明', followerMemberId: a.memberId });
    await tick();
    expect((await inbox(a.memberId)).slice(-2).map((n) => [n.kind, n.subjectType, n.title, n.body])).toEqual([
      ['assigned', 'requirement', 'PAN-1 登录页改版', '你是下一步跟进人：部署测试环境'],
      ['assigned', 'requirement', 'PAN-1 登录页改版', '你是下一步跟进人'],
    ]);
    expect((await inbox(b.memberId)).slice(-2).map((n) => [n.kind, n.body])).toEqual([
      ['followed_change', '写了进展：接口已联调完成，等待测试环境部署后验证'],
      ['followed_change', '写了进展：补充说明'],
    ]);
    expect(await inbox(owner.memberId)).toEqual([]);
  });

  it('跟进人离开或看不到对象：不写通知', async () => {
    await createProgress(t.db, owner, req(reqId), { body: '给外部访客', followerMemberId: outsider.memberId });
    await createProgress(t.db, owner, req(reqId), { body: '给王五', followerMemberId: leaver.memberId });
    await updateMember(t.db, owner, leaver.memberId, { status: 'left' });
    const w = await createWorkItem(t.db, owner, { title: '不关联产品的工作' });
    await createProgress(t.db, owner, wi(w.id), { body: '给访客', followerMemberId: guest.memberId });
    await tick();
    for (const m of [outsider, leaver, guest]) expect(await inbox(m.memberId)).toEqual([]);
  });

  it('修改进展换了跟进人：通知新的跟进人；没换跟进人不通知', async () => {
    const p = await createProgress(t.db, owner, req(reqId), { body: '先给张三', nextStep: '确认方案', followerMemberId: a.memberId });
    await tick();
    const before = (await inbox(b.memberId)).length;
    await updateProgress(t.db, owner, p.id, { followerMemberId: b.memberId });
    await updateProgress(t.db, owner, p.id, { body: '只改正文' });
    await tick();
    expect((await inbox(b.memberId)).slice(before).map((n) => [n.kind, n.body])).toEqual([['assigned', '你是下一步跟进人：确认方案']]);
  });
});

describe('工作项的关注与 @ 候选成员', () => {
  it('工作项可以关注，关注者在新进展时收到；访客不能关注不关联产品的工作项', async () => {
    const w = await createWorkItem(t.db, owner, { title: '可关注的工作' });
    expect(await setSubscription(t.db, a, { type: 'work_item', id: w.id }, true)).toEqual({ following: true, source: 'manual', reason: '你手动关注了' });
    await expect(getSubscription(t.db, guest, { type: 'work_item', id: w.id })).rejects.toMatchObject({ code: 'not_found' });
    await createProgress(t.db, b, wi(w.id), { body: '对方已确认' });
    await tick();
    expect(await last(a.memberId)).toMatchObject({ kind: 'followed_change', subjectType: 'work_item', title: `${w.displayKey} 可关注的工作`, body: '写了进展：对方已确认' });
  });

  it('组织级 @ 候选成员：访客标为看不到；访客自己不能读取', async () => {
    const list = await listMentionMembers(t.db, owner, null);
    expect(list.find((m) => m.id === guest.memberId)!.canSeeProduct).toBe(false);
    expect(list.find((m) => m.id === a.memberId)!.canSeeProduct).toBe(true);
    expect(list.find((m) => m.id === leaver.memberId)).toMatchObject({ status: 'left', canSeeProduct: false });
    await expect(listMentionMembers(t.db, guest, null)).rejects.toMatchObject({ code: 'forbidden' });
  });
});
