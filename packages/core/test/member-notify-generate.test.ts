import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { domainEvents, memberNotifications, notificationCursors, requirements, subscriptions } from '../src/db/schema';
import type { AccountView } from '../src/auth/accounts';
import { withOrg } from '../src/db/tx';
import { createWorkflowTemplate, setProductWorkflowVersion } from '../src/definitions/workflows';
import { listFields } from '../src/definitions/fields';
import type { Actor } from '../src/domain-types';
import { createDocument, saveDocumentContent, transitionDocument } from '../src/documents/documents';
import { recordEvent } from '../src/events';
import { createIteration } from '../src/iterations/iterations';
import { setRequirementIteration } from '../src/iterations/membership';
import { mentionMarkup } from '../src/links/syntax';
import { setNotificationPref } from '../src/member-notifications/prefs';
import { setSubscription } from '../src/member-notifications/subscriptions';
import { runNotificationTick } from '../src/notifications/worker';
import { addRequirementAssignment } from '../src/requirements/assignments';
import { addRequirementComment } from '../src/requirements/comments';
import { createRequirement, setRequirementField, updateRequirement } from '../src/requirements/requirements';
import { setCheckItemState, transitionRequirement } from '../src/requirements/transitions';
import { createTask, updateTask } from '../src/tasks/tasks';
import { listFunctionTags } from '../src/tenancy/function-tags';
import { setMemberFunctionTags, updateMember } from '../src/tenancy/members';
import { createOrganization, resolveActor } from '../src/tenancy/orgs';
import { createProduct } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, prdWorkflow, regularIteration, reviewWorkflow, seedInstance } from './factories';
import { TEST_DEPS } from './notify-helpers';
import { fakeTransport } from './notify-transport';

let t: Awaited<ReturnType<typeof createTestDb>>;
let account: AccountView;
let owner: Actor;
let a: Actor;
let b: Actor;
let boss: Actor;
let designer: Actor;
let guest: Actor;
let designTag: string;
let productId: string;
let docProductId: string;
let reqId: string;
const deps = { ...TEST_DEPS, transport: fakeTransport().transport };
const tick = (now?: Date) => runNotificationTick(t.db, deps, now);
const inbox = (memberId: string) =>
  t.adminDb.select().from(memberNotifications).where(eq(memberNotifications.memberId, memberId)).orderBy(asc(memberNotifications.createdAt), asc(memberNotifications.id));
const cursor = async () => (await t.adminDb.select().from(notificationCursors).where(eq(notificationCursors.orgId, owner.orgId)))[0]!;

beforeAll(async () => {
  t = await createTestDb();
  ({ account, owner } = await seedInstance(t.db));
  designTag = (await listFunctionTags(t.db, owner)).find((x) => x.name === '设计')!.id;
  productId = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  docProductId = (await createProduct(t.db, owner, { name: '文档', key: 'DOC' })).id;
  a = await asMember(t.db, owner, '张三');
  b = await asMember(t.db, owner, '李四');
  boss = await asMember(t.db, owner, '老板乙');
  designer = await asMember(t.db, owner, '设计师丁');
  await setMemberFunctionTags(t.db, owner, designer.memberId, [designTag]);
  guest = await asMember(t.db, owner, '访客');
  await updateMember(t.db, owner, guest.memberId, { orgRole: 'guest' });
  const review = await createWorkflowTemplate(t.db, owner, { name: '评审流程', body: reviewWorkflow(designTag, boss.memberId) });
  await setProductWorkflowVersion(t.db, owner, productId, review.version.id);
  const prd = await createWorkflowTemplate(t.db, owner, { name: 'PRD 流程', body: prdWorkflow(designTag) });
  await setProductWorkflowVersion(t.db, owner, docProductId, prd.version.id);
  reqId = (await createRequirement(t.db, owner, productId, { title: '登录页改版' })).id;
  await tick();
});
afterAll(() => t.cleanup());

describe('站内通知生成', () => {
  it('评论 @：被 @ 的人收到；本人与看不到产品的访客不收到；评论者与被 @ 者自动关注', async () => {
    await addRequirementComment(t.db, owner, reqId, {
      body: `${mentionMarkup(a.memberId, '张三')} ${mentionMarkup(owner.memberId, 'Owner')} ${mentionMarkup(guest.memberId, '访客')} 请看`,
    });
    const summary = await tick();
    expect(summary.notified).toBe(1);
    expect(await inbox(a.memberId)).toEqual([
      expect.objectContaining({
        kind: 'mentioned',
        subjectType: 'requirement',
        subjectId: reqId,
        title: 'PAN-1 登录页改版',
        body: '在评论中 @ 了你',
        url: '/acme/requirements/PAN-1',
        actorMemberId: owner.memberId,
        readAt: null,
      }),
    ]);
    expect(await inbox(owner.memberId)).toEqual([]);
    expect(await inbox(guest.memberId)).toEqual([]);
    const subs = await t.adminDb.select().from(subscriptions).where(eq(subscriptions.subjectId, reqId));
    expect(subs.map((s) => [s.memberId, s.source]).sort()).toEqual([[a.memberId, 'auto'], [owner.memberId, 'auto']].sort());
  });

  it('同一事件同一人只取最高的一种：既被设为负责人又被 @ 时只记被 @', async () => {
    await updateRequirement(t.db, owner, reqId, { ownerMemberId: b.memberId, description: `交给 ${mentionMarkup(b.memberId, '李四')}` });
    await tick();
    expect((await inbox(b.memberId)).map((n) => [n.kind, n.body])).toEqual([['mentioned', '在需求描述中 @ 了你']]);
  });

  it('关注对象变化：状态、优先级、迭代、新评论；取消关注的不收；操作人不收', async () => {
    await setSubscription(t.db, owner, { type: 'requirement', id: reqId }, false);
    await transitionRequirement(t.db, owner, reqId, { to: 'doing' });
    const p0 = (await listFields(t.db, owner)).find((f) => f.key === 'priority' && f.productId === null)!.options.find((o) => o.key === 'p0')!;
    await setRequirementField(t.db, owner, reqId, 'priority', [p0.id]);
    const it1 = await createIteration(t.db, owner, regularIteration(productId, '迭代一', '2026-10-01', '2026-10-31'));
    await setRequirementIteration(t.db, owner, reqId, { iterationId: it1.id });
    await addRequirementComment(t.db, b, reqId, { body: '我先看看 [[PAN-1]]' });
    await tick();
    expect((await inbox(a.memberId)).slice(1).map((n) => [n.kind, n.body])).toEqual([
      ['followed_change', '把状态从「收集」改为「开发中」'],
      ['followed_change', '把优先级从「空」改为「P0」'],
      ['followed_change', '把迭代改为「迭代一」'],
      ['followed_change', '发表了评论：我先看看 [[PAN-1]]'],
    ]);
    expect(await inbox(owner.memberId)).toEqual([]);
    expect((await inbox(b.memberId)).map((n) => n.body)).toEqual(['在需求描述中 @ 了你', '把状态从「收集」改为「开发中」', '把优先级从「空」改为「P0」', '把迭代改为「迭代一」']);
  });

  it('站内偏好关闭的类型不写站内通知', async () => {
    await setNotificationPref(t.db, a, 'followed_change', { inApp: false, wecom: false, email: false });
    const before = (await inbox(a.memberId)).length;
    await transitionRequirement(t.db, owner, reqId, { to: 'done' });
    await tick();
    expect(await inbox(a.memberId)).toHaveLength(before);
    await setNotificationPref(t.db, a, 'followed_change', { inApp: true, wecom: false, email: false });
  });

  it('被指派：新增分配（带职能名）与任务指派、改派', async () => {
    const r = await createRequirement(t.db, owner, productId, { title: '分享页' });
    await addRequirementAssignment(t.db, owner, r.id, { memberId: a.memberId, functionTagId: designTag });
    const task = await createTask(t.db, owner, { requirementId: r.id, title: '接口', assigneeMemberId: a.memberId });
    await updateTask(t.db, owner, task.id, { assigneeMemberId: b.memberId });
    await tick();
    expect((await inbox(a.memberId)).slice(-2).map((n) => [n.kind, n.subjectType, n.body, n.url])).toEqual([
      ['assigned', 'requirement', '把你分配为「设计」', '/acme/requirements/PAN-2'],
      ['assigned', 'task', '把任务指派给你', '/acme/tasks/PAN-T-1'],
    ]);
    expect((await inbox(b.memberId)).at(-1)).toMatchObject({ kind: 'assigned', subjectType: 'task', title: 'PAN-T-1 接口' });
  });

  it('等我签字：需求评审由这次检查项变化开始时，按分配给对应成员，没有分配时给标签持有者；之后的变化不重复', async () => {
    const plain = await createRequirement(t.db, owner, productId, { title: '回收站' });
    const assigned = await createRequirement(t.db, owner, productId, { title: '上传' });
    const other = await asMember(t.db, owner, '设计师戊');
    await setMemberFunctionTags(t.db, owner, other.memberId, [designTag]);
    await addRequirementAssignment(t.db, owner, assigned.id, { memberId: other.memberId, functionTagId: designTag });
    await tick();
    await setCheckItemState(t.db, owner, plain.id, 'feasibility', { state: 'in_progress' });
    await setCheckItemState(t.db, owner, assigned.id, 'feasibility', { state: 'in_progress' });
    await tick();
    const due = async (m: Actor, id: string) => (await inbox(m.memberId)).filter((n) => n.subjectId === id && n.kind === 'signoff_due');
    expect((await due(designer, plain.id)).map((n) => n.body)).toEqual(['「设计签字」等你签字']);
    expect(await due(boss, plain.id)).toHaveLength(1);
    expect(await due(designer, assigned.id)).toHaveLength(0);
    expect(await due(other, assigned.id)).toHaveLength(1);
    await setCheckItemState(t.db, owner, plain.id, 'feasibility', { state: 'passed' });
    await tick();
    expect(await due(designer, plain.id)).toHaveLength(1);
  });

  it('PRD：负责人被指派、正文新增的 @、进入评审时等签字的人与关注者', async () => {
    const doc = await createDocument(t.db, owner, docProductId, { title: '上传 PRD', ownerMemberId: a.memberId });
    await saveDocumentContent(t.db, owner, doc.id, { baseVersion: doc.version, markdown: `# 背景\n\n${mentionMarkup(b.memberId, '李四')} 配合` });
    await tick();
    expect((await inbox(a.memberId)).at(-1)).toMatchObject({ kind: 'assigned', body: '把你设为 PRD 负责人', title: 'DOC-PRD-1 上传 PRD', url: '/acme/documents/DOC-PRD-1' });
    expect((await inbox(b.memberId)).at(-1)).toMatchObject({ kind: 'mentioned', body: '在 PRD 正文中 @ 了你' });
    await transitionDocument(t.db, owner, doc.id, { to: 'review' });
    await tick();
    expect((await inbox(designer.memberId)).at(-1)).toMatchObject({ kind: 'signoff_due', subjectType: 'document', body: '「PRD 评审」等你签字' });
    expect((await inbox(a.memberId)).at(-1)).toMatchObject({ kind: 'followed_change', body: '把 PRD 状态从「草稿」改为「评审中」' });
  });

  it('收件人在处理前离开或看不到产品：不写通知、不补自动关注', async () => {
    const x = await asMember(t.db, owner, '将离开');
    const y = await asMember(t.db, owner, '将变访客');
    await addRequirementComment(t.db, owner, reqId, { body: `${mentionMarkup(x.memberId, '将离开')} ${mentionMarkup(y.memberId, '将变访客')}` });
    await updateMember(t.db, owner, x.memberId, { status: 'left' });
    await updateMember(t.db, owner, y.memberId, { orgRole: 'guest' });
    await tick();
    expect(await inbox(x.memberId)).toEqual([]);
    expect(await inbox(y.memberId)).toEqual([]);
    expect(await t.adminDb.select().from(subscriptions).where(inArray(subscriptions.memberId, [x.memberId, y.memberId]))).toEqual([]);
  });

  it('对象已删除的事件跳过且游标前移；legacy 事件不处理', async () => {
    const r = await createRequirement(t.db, owner, productId, { title: '将删除' });
    await addRequirementComment(t.db, owner, r.id, { body: `${mentionMarkup(a.memberId, '张三')} 看看` });
    await t.adminDb.update(requirements).set({ deletedAt: new Date() }).where(eq(requirements.id, r.id));
    await t.adminDb.insert(domainEvents).values({ orgId: owner.orgId, productId, type: 'legacy.push.change', subjectType: 'requirement', subjectId: reqId, payload: { mentionedMemberIds: [a.memberId] } });
    const summary = await tick();
    expect(summary.events).toBeGreaterThanOrEqual(3);
    expect((await inbox(a.memberId)).filter((n) => n.subjectId === r.id)).toEqual([]);
    const [latest] = await t.adminDb.select({ id: domainEvents.id }).from(domainEvents).where(eq(domainEvents.orgId, owner.orgId)).orderBy(desc(domainEvents.occurredAt), desc(domainEvents.id)).limit(1);
    expect((await cursor()).lastEventId).toBe(latest!.id);
  });

  it('未提交事务里的事件不被跳过：晚开始先提交的事件也等它提交后按顺序处理', async () => {
    const r = await createRequirement(t.db, owner, productId, { title: '长事务' });
    await tick();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const begun = new Promise<void>((resolve) => {
      started = resolve;
    });
    const slow = withOrg(t.db, owner.orgId, async (tx) => {
      await recordEvent(tx, { orgId: owner.orgId, productId, type: 'requirement.updated', subjectType: 'requirement', subjectId: r.id, actor: owner, payload: { changes: [], mentionedMemberIds: [a.memberId] } });
      started();
      await hold;
    });
    await begun;
    await addRequirementComment(t.db, owner, r.id, { body: `${mentionMarkup(b.memberId, '李四')} 先提交` });
    await tick();
    expect((await inbox(b.memberId)).filter((n) => n.subjectId === r.id)).toEqual([]);
    release();
    await slow;
    await tick();
    // 长事务的事件先处理：张三被 @ 后自动关注，随后的评论按关注变化通知他
    expect((await inbox(a.memberId)).filter((n) => n.subjectId === r.id).map((n) => n.body)).toEqual(['在需求描述中 @ 了你', '发表了评论：@李四 先提交']);
    expect((await inbox(b.memberId)).filter((n) => n.subjectId === r.id).map((n) => n.body)).toEqual(['在评论中 @ 了你']);
  });

  it('同一条事件连续失败 3 次后跳过并记录警告，之后的事件照常处理', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await t.adminDb.insert(domainEvents).values({ orgId: owner.orgId, productId, type: 'comment.created', subjectType: 'requirement', subjectId: reqId, actorMemberId: owner.memberId, payload: { commentId: 'not-a-uuid' } });
    await addRequirementComment(t.db, owner, reqId, { body: `${mentionMarkup(a.memberId, '张三')} 后到` });
    const before = (await inbox(a.memberId)).length;
    await tick();
    await tick();
    expect(await inbox(a.memberId)).toHaveLength(before);
    expect((await cursor()).failures).toBe(2);
    await tick();
    expect(await inbox(a.memberId)).toHaveLength(before + 1);
    expect(await cursor()).toMatchObject({ failures: 0, failingEventId: null });
    expect(warn.mock.calls.some(([m]) => String(m).includes('连续失败 3 次，跳过该事件'))).toBe(true);
    warn.mockRestore();
    const rows = await t.adminDb.select().from(memberNotifications).where(and(eq(memberNotifications.memberId, a.memberId), eq(memberNotifications.subjectId, reqId)));
    expect(new Set(rows.map((r) => `${r.eventId}:${r.kind}`)).size).toBe(rows.length);
  });

  it('没有游标行与游标全为空的组织都从头处理', async () => {
    const setup = async (slug: string) => {
      await createOrganization(t.db, account, { name: slug, slug });
      const o = (await resolveActor(t.db, account.id, slug))!;
      const pid = (await createProduct(t.db, o, { name: '相册', key: 'ALB' })).id;
      const m = await asMember(t.db, o, '组员');
      const r = await createRequirement(t.db, o, pid, { title: '首页' });
      await addRequirementComment(t.db, o, r.id, { body: `${mentionMarkup(m.memberId, '组员')} 看看` });
      return { o, m };
    };
    const missing = await setup('fresh');
    const nulls = await setup('nulls');
    await t.adminDb.insert(notificationCursors).values({ orgId: nulls.o.orgId });
    const cursorOf = async (orgId: string) => (await t.adminDb.select().from(notificationCursors).where(eq(notificationCursors.orgId, orgId)))[0];
    expect(await cursorOf(missing.o.orgId)).toBeUndefined();
    expect(await cursorOf(nulls.o.orgId)).toMatchObject({ lastOccurredAt: null, lastEventId: null });
    const summary = await tick();
    expect(summary.orgs).toBe(2);
    for (const { o, m } of [missing, nulls]) {
      expect((await inbox(m.memberId)).map((n) => [n.kind, n.body])).toEqual([['mentioned', '在评论中 @ 了你']]);
      const [latest] = await t.adminDb.select({ id: domainEvents.id }).from(domainEvents).where(eq(domainEvents.orgId, o.orgId)).orderBy(desc(domainEvents.occurredAt), desc(domainEvents.id)).limit(1);
      expect((await cursorOf(o.orgId))!.lastEventId).toBe(latest!.id);
    }
    expect((await tick()).orgs).toBe(0);
  });
});
