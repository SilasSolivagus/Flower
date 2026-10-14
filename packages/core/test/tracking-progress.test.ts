import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { domainEvents } from '../src/db/schema';
import type { Actor } from '../src/domain-types';
import { getRequirementByKey } from '../src/requirements/detail';
import { createRequirement } from '../src/requirements/requirements';
import { createAgentMember, updateMember } from '../src/tenancy/members';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createProgress, deleteProgress, listProgress, type ProgressSubject, updateProgress } from '../src/tracking/progress';
import { createWorkItem, deleteWorkItem, getWorkItemByKey } from '../src/tracking/work-items';
import { createTestDb } from './db';
import { applyTrackingWorkflow, asMember, readOnlyToken, seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let ed: Actor;
let peer: Actor;
let padmin: Actor;
let viewer: Actor;
let leaver: Actor;
let agentId: string;
let pan: string;

const req = (id: string): ProgressSubject => ({ type: 'requirement', id });
const wi = (id: string): ProgressSubject => ({ type: 'work_item', id });
const newReq = async (title: string) => createRequirement(t.db, owner, pan, { title });
const eventTypes = async (id: string, types: string[]) =>
  (await t.adminDb.select().from(domainEvents).where(and(eq(domainEvents.subjectId, id), inArray(domainEvents.type, types)))).map((e) => e.type).sort();

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  await applyTrackingWorkflow(t.db, owner, pan);
  ed = await asMember(t.db, owner, '编辑甲');
  peer = await asMember(t.db, owner, '同事乙');
  padmin = await asMember(t.db, owner, '产品管理员');
  await setProductRole(t.db, owner, pan, padmin.memberId, 'admin');
  viewer = await asMember(t.db, owner, '只读成员');
  await setProductRole(t.db, owner, pan, viewer.memberId, 'viewer');
  leaver = await asMember(t.db, owner, '将离开的人');
  agentId = (await createAgentMember(t.db, owner, { displayName: '机器人' })).id;
});
afterAll(() => t.cleanup());

describe('需求的进展记录', () => {
  it('写进展：进展必填，下一步与跟进人可选，时间倒序；可以顺手改预计上线日期', async () => {
    const r = await newReq('进展需求');
    await expect(createProgress(t.db, ed, req(r.id), { body: ' ' })).rejects.toMatchObject({ code: 'invalid', message: '进展不能为空，且不超过 2000 个字符' });
    await expect(createProgress(t.db, ed, req(r.id), { body: '有进展', nextStep: 'x'.repeat(501) })).rejects.toMatchObject({ code: 'invalid', message: '下一步不超过 500 个字符' });
    const p1 = await createProgress(t.db, ed, req(r.id), { body: ' 完成接口评审 ', nextStep: ' ', followerMemberId: null });
    expect(p1).toMatchObject({ body: '完成接口评审', nextStep: null, follower: null, author: { id: ed.memberId, displayName: '编辑甲' }, canEdit: true, canDelete: true, editedAt: null });
    const p2 = await createProgress(t.db, ed, req(r.id), { body: '联调中', nextStep: '约测试', followerMemberId: peer.memberId, expectedDate: '2026-11-01' });
    expect(p2.follower).toEqual({ id: peer.memberId, displayName: '同事乙' });
    expect((await listProgress(t.db, peer, req(r.id))).map((p) => [p.body, p.canEdit, p.canDelete])).toEqual([
      ['联调中', false, false],
      ['完成接口评审', false, false],
    ]);
    expect((await getRequirementByKey(t.db, owner, r.displayKey)).tracking.expectedDate).toBe('2026-11-01');
    expect(await eventTypes(r.id, ['progress.created', 'requirement.expected_date_changed'])).toEqual(
      ['progress.created', 'progress.created', 'requirement.expected_date_changed'].sort(),
    );
  });

  it('跟进人校验：已离开的成员与 Agent 不能选；已保存的进展在跟进人离开后仍显示原名', async () => {
    const r = await newReq('跟进人');
    const p = await createProgress(t.db, ed, req(r.id), { body: '交接', followerMemberId: leaver.memberId });
    await updateMember(t.db, owner, leaver.memberId, { status: 'left' });
    expect((await listProgress(t.db, ed, req(r.id)))[0]!.follower).toEqual({ id: leaver.memberId, displayName: '将离开的人' });
    await expect(createProgress(t.db, ed, req(r.id), { body: '再交接', followerMemberId: leaver.memberId })).rejects.toMatchObject({ code: 'invalid', message: '该成员已离开组织，不能选择' });
    await expect(createProgress(t.db, ed, req(r.id), { body: '给机器人', followerMemberId: agentId })).rejects.toMatchObject({ code: 'invalid', message: '不能选择 Agent 成员' });
    expect((await updateProgress(t.db, ed, p.id, { body: '交接（补充）' })).follower).toEqual({ id: leaver.memberId, displayName: '将离开的人' });
    await expect(updateProgress(t.db, ed, p.id, { followerMemberId: agentId })).rejects.toMatchObject({ code: 'invalid', message: '不能选择 Agent 成员' });
  });

  it('修改与删除：作者本人可以；产品管理员可以删除别人的；只读成员、只读 Token 不能写', async () => {
    const r = await newReq('修改删除');
    const p = await createProgress(t.db, ed, req(r.id), { body: '原文' });
    await expect(updateProgress(t.db, peer, p.id, { body: '改别人的' })).rejects.toMatchObject({ code: 'forbidden', message: '只能修改自己写的进展' });
    const edited = await updateProgress(t.db, ed, p.id, { body: '改过', nextStep: '下周复盘' });
    expect(edited).toMatchObject({ body: '改过', nextStep: '下周复盘' });
    expect(edited.editedAt).not.toBeNull();
    const [updated] = await t.adminDb.select().from(domainEvents).where(and(eq(domainEvents.subjectId, r.id), eq(domainEvents.type, 'progress.updated')));
    expect(updated!.payload).toMatchObject({
      progressId: p.id,
      changes: [
        { field: 'body', old: '原文', new: '改过' },
        { field: 'nextStep', old: null, new: '下周复盘' },
      ],
    });
    await expect(deleteProgress(t.db, peer, p.id)).rejects.toMatchObject({ code: 'forbidden', message: '没有删除这条进展的权限' });
    await deleteProgress(t.db, padmin, p.id);
    expect(await listProgress(t.db, ed, req(r.id))).toEqual([]);
    await expect(updateProgress(t.db, ed, p.id, { body: '已删' })).rejects.toMatchObject({ code: 'not_found', message: '进展记录不存在' });
    for (const a of [viewer, readOnlyToken(owner)]) await expect(createProgress(t.db, a, req(r.id), { body: '只读' })).rejects.toMatchObject({ code: 'forbidden' });
    expect(await eventTypes(r.id, ['progress.deleted'])).toEqual(['progress.deleted']);
  });
});

describe('工作项的进展记录', () => {
  it('不关联产品时能查看的非只读成员都能写；顺手改预计完成日期需要修改权限；组织管理员可以删除别人的', async () => {
    const w = await createWorkItem(t.db, ed, { title: '工作项进展' });
    const p = await createProgress(t.db, peer, wi(w.id), { body: '对方已回复' });
    await expect(createProgress(t.db, peer, wi(w.id), { body: '顺手改日期', expectedDate: '2026-11-11' })).rejects.toMatchObject({ code: 'forbidden' });
    await createProgress(t.db, ed, wi(w.id), { body: '负责人改日期', expectedDate: '2026-11-11' });
    expect((await getWorkItemByKey(t.db, ed, w.displayKey)).expectedDate).toBe('2026-11-11');
    expect((await listProgress(t.db, owner, wi(w.id))).find((x) => x.id === p.id)).toMatchObject({ canEdit: false, canDelete: true });
    await deleteProgress(t.db, owner, p.id);
    expect((await listProgress(t.db, ed, wi(w.id))).map((x) => x.body)).toEqual(['负责人改日期']);
  });

  it('已删除对象：已删除的工作项不能再写进展，也读不到进展', async () => {
    const w = await createWorkItem(t.db, ed, { title: '要删除的工作项' });
    await deleteWorkItem(t.db, ed, w.id);
    await expect(createProgress(t.db, ed, wi(w.id), { body: '删了还写' })).rejects.toMatchObject({ code: 'not_found', message: '工作项不存在' });
    await expect(listProgress(t.db, ed, wi(w.id))).rejects.toMatchObject({ code: 'not_found' });
  });
});
