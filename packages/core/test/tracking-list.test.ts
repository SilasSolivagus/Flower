import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { domainEvents, products, requirements, stateTransitions, workItems } from '../src/db/schema';
import { listFields } from '../src/definitions/fields';
import type { Actor } from '../src/domain-types';
import { createBlocker, resolveBlocker } from '../src/requirements/blockers';
import { createRequirement, setRequirementField } from '../src/requirements/requirements';
import { transitionRequirement } from '../src/requirements/transitions';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createProgress } from '../src/tracking/progress';
import { joinTracking, pauseRequirement, resumeRequirement } from '../src/tracking/requirement-tracking';
import { getTrackingSettings, updateTrackingSettings } from '../src/tracking/settings';
import { getTracking, type TrackingList } from '../src/tracking/tracking';
import { createWorkItem, setWorkItemStatus, updateWorkItem } from '../src/tracking/work-items';
import { createTestDb } from './db';
import { applyTrackingWorkflow, asMember, seedInstance } from './factories';

/** 北京时间 2026-10-13 12:00。 */
const NOW = new Date('2026-10-13T04:00:00Z');
const at = (iso: string) => new Date(iso);
const RANDOM = '00000000-0000-4000-8000-000000000001';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let ed: Actor;
let peer: Actor;
let guest: Actor;
let panToken: Actor;
let pan: string;
let doc: string;
let feature: string;
let p1: string;
let support: string;

const create = (title: string, extra: { productId?: string; ownerMemberId?: string } = {}) =>
  createRequirement(t.db, owner, extra.productId ?? pan, { title, ownerMemberId: extra.ownerMemberId });
const move = (id: string, to: string) => transitionRequirement(t.db, owner, id, { to });
const rewrite = (id: string, patch: Partial<typeof requirements.$inferInsert>) => t.adminDb.update(requirements).set(patch).where(eq(requirements.id, id));
/** 把某个对象某类事件的时间改到过去（暂停、恢复）。 */
const shiftEvent = (id: string, type: string, iso: string) =>
  t.adminDb.update(domainEvents).set({ occurredAt: at(iso) }).where(and(eq(domainEvents.subjectId, id), eq(domainEvents.type, type)));
const pick = (list: TrackingList, prefix: string) => list.items.filter((i) => i.title.startsWith(prefix));

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  doc = (await createProduct(t.db, owner, { name: '文档', key: 'DOC' })).id;
  await applyTrackingWorkflow(t.db, owner, pan);
  await applyTrackingWorkflow(t.db, owner, doc);
  ed = await asMember(t.db, owner, '编辑甲');
  peer = await asMember(t.db, owner, '同事乙');
  guest = await asMember(t.db, owner, '访客丙', 'guest');
  await setProductRole(t.db, owner, pan, guest.memberId, 'viewer');
  panToken = { ...owner, tokenId: '00000000-0000-0000-0000-0000000000f3', tokenScope: { products: [pan], access: 'read' } };
  const fields = await listFields(t.db, owner);
  const option = (field: string, key: string) => fields.find((f) => f.key === field)!.options.find((o) => o.key === key)!.id;
  feature = option('type', 'feature');
  p1 = option('priority', 'p1');
  support = option('work_type', 'support');
});
afterAll(() => t.cleanup());

describe('跟进列表', () => {
  it('全部在手：跟进中的需求（含手动加入的收集阶段）与进行中的工作项；未加入、已上线、已删除、已完成的不在', async () => {
    const a = await create('[在手] 开发中的需求', { ownerMemberId: ed.memberId });
    await move(a.id, 'dev');
    const manual = await create('[在手] 手动加入的收集需求');
    await joinTracking(t.db, owner, manual.id);
    await create('[在手] 没加入的需求');
    const shipped = await create('[在手] 已上线的需求');
    await move(shipped.id, 'dev');
    await move(shipped.id, 'done');
    const removed = await create('[在手] 删除的需求');
    await move(removed.id, 'dev');
    await rewrite(removed.id, { deletedAt: new Date() });
    const w = await createWorkItem(t.db, ed, { title: '[在手] 协助排查', ownerMemberId: ed.memberId, startedOn: '2026-10-08' });
    const finished = await createWorkItem(t.db, ed, { title: '[在手] 已完成的工作' });
    await setWorkItemStatus(t.db, ed, finished.id, 'done');
    const list = await getTracking(t.db, owner, {}, { now: NOW });
    expect(list).toMatchObject({ today: '2026-10-13', timeZone: 'Asia/Shanghai', settings: { warnDays: 14, alertDays: 30, staleUpdateDays: 7 } });
    expect(pick(list, '[在手]').map((i) => i.title).sort()).toEqual(['[在手] 开发中的需求', '[在手] 手动加入的收集需求', '[在手] 协助排查'].sort());
    expect(pick(list, '[在手] 开发中')[0]).toMatchObject({
      kind: 'requirement',
      displayKey: a.displayKey,
      product: { id: pan, key: 'PAN', name: '网盘' },
      owner: { id: ed.memberId, displayName: '编辑甲' },
      stage: { key: 'dev', label: '开发中', category: 'started' },
      paused: null,
      blockers: { count: 0, first: null },
      latest: null,
      done: false,
      doneOn: null,
      canWrite: true,
      canEditDate: true,
    });
    expect(pick(list, '[在手] 协助')[0]).toMatchObject({
      kind: 'work_item',
      displayKey: w.displayKey,
      product: null,
      priority: null,
      stage: { key: 'active', label: '进行中', category: 'started' },
      startedOn: '2026-10-08',
      stageEnteredOn: '2026-10-08',
      stageDays: 5,
      wipDays: 5,
    });
  });

  it('退回收集与重新打开仍在手，停留从新的状态重新计算', async () => {
    const back = await create('[重开] 退回收集');
    await move(back.id, 'dev');
    await move(back.id, 'backlog');
    const again = await create('[重开] 重新打开');
    await move(again.id, 'dev');
    await move(again.id, 'done');
    await move(again.id, 'dev');
    const list = await getTracking(t.db, owner);
    expect(pick(list, '[重开]').map((i) => [i.title, i.stage.label, i.stageDays, i.done])).toEqual([
      ['[重开] 退回收集', '收集', 0, false],
      ['[重开] 重新打开', '开发中', 0, false],
    ]);
  });

  it('停留与在制扣除暂停（按组织时区的自然日）；老化分档；暂停中不标色、不计无进展', async () => {
    const r20 = await create('[老化] 停留 20 天');
    await move(r20.id, 'dev');
    await rewrite(r20.id, { stateChangedAt: at('2026-09-23T02:00:00Z'), trackedSince: at('2026-09-01T02:00:00Z') });
    const r40 = await create('[老化] 停留 40 天，暂停 5 天');
    await move(r40.id, 'dev');
    await pauseRequirement(t.db, owner, r40.id, { reason: '等资源' });
    await resumeRequirement(t.db, owner, r40.id);
    await shiftEvent(r40.id, 'requirement.paused', '2026-09-10T02:00:00Z');
    await shiftEvent(r40.id, 'requirement.resumed', '2026-09-15T02:00:00Z');
    await rewrite(r40.id, { stateChangedAt: at('2026-09-03T02:00:00Z'), trackedSince: at('2026-09-03T02:00:00Z') });
    const paused = await create('[老化] 暂停中');
    await move(paused.id, 'dev');
    await pauseRequirement(t.db, owner, paused.id, { reason: '等法务' });
    await shiftEvent(paused.id, 'requirement.paused', '2026-09-13T02:00:00Z');
    await rewrite(paused.id, { stateChangedAt: at('2026-08-14T02:00:00Z'), trackedSince: at('2026-08-14T02:00:00Z') });
    const fresh = await create('[老化] 有新进展');
    await move(fresh.id, 'dev');
    await rewrite(fresh.id, { stateChangedAt: at('2026-10-10T02:00:00Z'), trackedSince: at('2026-09-01T02:00:00Z') });
    await createProgress(t.db, owner, { type: 'requirement', id: fresh.id }, { body: '刚同步过' });
    await createWorkItem(t.db, ed, { title: '[老化] 工作项', startedOn: '2026-09-28' });
    const list = await getTracking(t.db, owner, {}, { now: NOW });
    expect(pick(list, '[老化]').map((i) => [i.title, i.stageDays, i.wipDays, i.aging, i.stale])).toEqual([
      ['[老化] 停留 40 天，暂停 5 天', 35, 35, 'alert', true],
      ['[老化] 暂停中', 30, 30, 'normal', false],
      ['[老化] 停留 20 天', 20, 42, 'warn', true],
      ['[老化] 工作项', 15, 15, 'warn', false],
      ['[老化] 有新进展', 3, 42, 'normal', false],
    ]);
    expect(pick(list, '[老化] 暂停中')[0]!.paused).toMatchObject({ reason: '等法务' });
  });

  it('阈值：组织管理员修改，校验范围与大小关系，记事件；修改后老化分档随之变化（沿用上一个用例的条目）', async () => {
    const valid = { warnDays: 25, alertDays: 50, staleUpdateDays: 3 };
    await expect(updateTrackingSettings(t.db, ed, valid)).rejects.toMatchObject({ code: 'forbidden' });
    for (const bad of [{ ...valid, warnDays: 0 }, { ...valid, staleUpdateDays: 1.5 }, { ...valid, alertDays: 366 }]) {
      await expect(updateTrackingSettings(t.db, owner, bad)).rejects.toMatchObject({ code: 'invalid', message: '天数应为 1–365 的整数' });
    }
    await expect(updateTrackingSettings(t.db, owner, { ...valid, warnDays: 50 })).rejects.toMatchObject({ code: 'invalid', message: '标黄天数应小于标红天数' });
    expect(await updateTrackingSettings(t.db, owner, valid)).toEqual(valid);
    expect(await getTrackingSettings(t.db, ed)).toEqual(valid);
    const [ev] = await t.adminDb.select().from(domainEvents).where(eq(domainEvents.type, 'organization.tracking_settings_changed'));
    expect(ev!.payload).toMatchObject({
      changes: [
        { field: 'warnDays', old: 14, new: 25 },
        { field: 'alertDays', old: 30, new: 50 },
        { field: 'staleUpdateDays', old: 7, new: 3 },
      ],
    });
    const list = await getTracking(t.db, owner, {}, { now: NOW });
    expect(pick(list, '[老化]').map((i) => [i.title, i.aging])).toEqual([
      ['[老化] 停留 40 天，暂停 5 天', 'warn'],
      ['[老化] 暂停中', 'normal'],
      ['[老化] 停留 20 天', 'normal'],
      ['[老化] 工作项', 'normal'],
      ['[老化] 有新进展', 'normal'],
    ]);
    await updateTrackingSettings(t.db, owner, { warnDays: 14, alertDays: 30, staleUpdateDays: 7 });
  });

  it('最新进展、进行中的阻塞项（条数与第一条）、类型与优先级', async () => {
    const r = await create('[明细] 带进展');
    await move(r.id, 'dev');
    await createProgress(t.db, owner, { type: 'requirement', id: r.id }, { body: '第一次进展' });
    await createProgress(t.db, owner, { type: 'requirement', id: r.id }, { body: '第二次进展', nextStep: '约评审', followerMemberId: ed.memberId });
    await createBlocker(t.db, owner, r.id, { description: '等接口' });
    await createBlocker(t.db, owner, r.id, { description: '等设计稿' });
    const solved = await createBlocker(t.db, owner, r.id, { description: '已解决的' });
    await resolveBlocker(t.db, owner, solved.id);
    await setRequirementField(t.db, owner, r.id, 'type', [feature]);
    await setRequirementField(t.db, owner, r.id, 'priority', [p1]);
    const [item] = pick(await getTracking(t.db, owner), '[明细]');
    expect(item!.latest).toMatchObject({ body: '第二次进展', nextStep: '约评审', follower: { id: ed.memberId, displayName: '编辑甲' } });
    expect(item!.blockers).toEqual({ count: 2, first: '等接口' });
    expect(item!.type).toMatchObject({ id: feature, label: '新功能' });
    expect(item!.priority).toMatchObject({ id: p1, label: 'P1' });
  });

  it('含最近完成：最近 30 天上线的需求与完成的工作项；更早完成的不含；完成的条目不标老化', async () => {
    const recent = await create('[完成] 上线 10 天');
    await move(recent.id, 'dev');
    await move(recent.id, 'done');
    await t.adminDb.update(stateTransitions).set({ at: at('2026-10-03T02:00:00Z') }).where(and(eq(stateTransitions.requirementId, recent.id), eq(stateTransitions.toState, 'done')));
    const old = await create('[完成] 上线 40 天');
    await move(old.id, 'dev');
    await move(old.id, 'done');
    await t.adminDb.update(stateTransitions).set({ at: at('2026-09-03T02:00:00Z') }).where(and(eq(stateTransitions.requirementId, old.id), eq(stateTransitions.toState, 'done')));
    const w = await createWorkItem(t.db, ed, { title: '[完成] 工作项' });
    await setWorkItemStatus(t.db, ed, w.id, 'done');
    await t.adminDb.update(workItems).set({ doneAt: at('2026-10-05T02:00:00Z') }).where(eq(workItems.id, w.id));
    const early = await createWorkItem(t.db, ed, { title: '[完成] 早完成的工作项' });
    await setWorkItemStatus(t.db, ed, early.id, 'done');
    await t.adminDb.update(workItems).set({ doneAt: at('2026-09-01T02:00:00Z') }).where(eq(workItems.id, early.id));
    expect(pick(await getTracking(t.db, owner, {}, { now: NOW }), '[完成]')).toEqual([]);
    const withDone = await getTracking(t.db, owner, { includeDone: true }, { now: NOW });
    expect(pick(withDone, '[完成]').map((i) => [i.title, i.done, i.doneOn, i.aging, i.stale])).toEqual([
      ['[完成] 上线 10 天', true, '2026-10-03', 'normal', false],
      ['[完成] 工作项', true, '2026-10-05', 'normal', false],
    ]);
  });

  it('按可见产品过滤：访客只看到有角色的产品，看不到不关联产品的工作项；工作项移到看不到的产品后不再出现；限定产品的 Token 看不到不关联产品的工作项', async () => {
    const pr = await create('[可见] 网盘需求');
    await move(pr.id, 'dev');
    const dr = await create('[可见] 文档需求', { productId: doc });
    await move(dr.id, 'dev');
    await createWorkItem(t.db, ed, { title: '[可见] 不关联产品' });
    const linked = await createWorkItem(t.db, ed, { title: '[可见] 网盘工作项', productId: pan });
    expect(pick(await getTracking(t.db, owner), '[可见]')).toHaveLength(4);
    const g = await getTracking(t.db, guest);
    expect(pick(g, '[可见]').map((i) => i.title).sort()).toEqual(['[可见] 网盘需求', '[可见] 网盘工作项'].sort());
    expect(g.products.map((p) => p.key)).toEqual(['PAN']);
    expect(pick(g, '[可见] 网盘需求')[0]).toMatchObject({ canWrite: false, canEditDate: false });
    for (const hidden of ['[可见] 文档需求', '[可见] 不关联产品', doc]) expect(JSON.stringify(g)).not.toContain(hidden);
    await updateWorkItem(t.db, ed, linked.id, { productId: doc });
    expect(pick(await getTracking(t.db, guest), '[可见]').map((i) => i.title)).toEqual(['[可见] 网盘需求']);
    expect(pick(await getTracking(t.db, panToken), '[可见]').map((i) => i.title)).toEqual(['[可见] 网盘需求']);
  });

  it('看不到或不存在的筛选值返回空结果，不报错；按负责人、类型、暂停、阻塞、产品筛选；候选负责人不受负责人筛选影响', async () => {
    const mine = await create('[筛选] 编辑的需求', { ownerMemberId: ed.memberId });
    await move(mine.id, 'dev');
    const theirs = await create('[筛选] 同事的需求', { ownerMemberId: peer.memberId });
    await move(theirs.id, 'dev');
    await pauseRequirement(t.db, owner, theirs.id, { reason: '等资源' });
    await createBlocker(t.db, owner, mine.id, { description: '等接口' });
    await createWorkItem(t.db, ed, { title: '[筛选] 工作项', workTypeOptionId: support });
    for (const f of [{ productId: RANDOM }, { ownerId: RANDOM }, { typeOptionId: RANDOM }]) {
      const list = await getTracking(t.db, owner, f);
      expect(list.items, JSON.stringify(f)).toEqual([]);
      expect(list.products.map((p) => p.key)).toEqual(['DOC', 'PAN']);
    }
    expect((await getTracking(t.db, guest, { productId: doc })).items).toEqual([]);
    const byOwner = await getTracking(t.db, owner, { ownerId: peer.memberId });
    expect(pick(byOwner, '[筛选]').map((i) => i.title)).toEqual(['[筛选] 同事的需求']);
    expect(byOwner.owners.map((o) => o.id)).toEqual(expect.arrayContaining([ed.memberId, peer.memberId]));
    expect(pick(await getTracking(t.db, owner, { typeOptionId: support }), '[筛选]').map((i) => i.title)).toEqual(['[筛选] 工作项']);
    expect(pick(await getTracking(t.db, owner, { paused: true }), '[筛选]').map((i) => i.title)).toEqual(['[筛选] 同事的需求']);
    expect(pick(await getTracking(t.db, owner, { blocked: true }), '[筛选]').map((i) => i.title)).toEqual(['[筛选] 编辑的需求']);
    expect(pick(await getTracking(t.db, owner, { productId: pan }), '[筛选]').map((i) => i.title).sort()).toEqual(['[筛选] 同事的需求', '[筛选] 编辑的需求'].sort());
    expect((await getTracking(t.db, owner)).typeOptions.map((o) => o.label)).toEqual(['新功能', '体验优化', '线上问题', '技术支持', '协调对接']);
  });
});

describe('跟进列表：产品没有指定流程', () => {
  it('不报错，状态列表为空，需求按收集类别处理', async () => {
    const bare = (await createProduct(t.db, owner, { name: '无流程', key: 'BARE' })).id;
    const r = await create('[无流程] 需求', { productId: bare });
    await joinTracking(t.db, owner, r.id);
    await t.adminDb.update(products).set({ workflowVersionId: null }).where(eq(products.id, bare));
    const list = await getTracking(t.db, owner, { productId: bare }, { now: NOW });
    expect(list.products.find((p) => p.id === bare)).toMatchObject({ key: 'BARE', states: [] });
    expect(pick(list, '[无流程]')[0]).toMatchObject({ stage: { category: 'backlog' }, done: false });
  });
});
