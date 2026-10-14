import { and, asc, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { domainEvents } from '../src/db/schema';
import { listFields } from '../src/definitions/fields';
import type { Actor } from '../src/domain-types';
import { mentionMarkup, parseWorkItemKey, workItemDisplayKey } from '../src/links/syntax';
import { createWorkItemBlocker, resolveBlocker } from '../src/requirements/blockers';
import { createProduct, setProductRole } from '../src/tenancy/products';
import {
  createWorkItem,
  deleteWorkItem,
  getWorkItemByKey,
  pauseWorkItem,
  resumeWorkItem,
  setWorkItemStatus,
  updateWorkItem,
} from '../src/tracking/work-items';
import { createTestDb } from './db';
import { asMember, readOnlyToken, seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let ed: Actor;
let peer: Actor;
let docViewer: Actor;
let guest: Actor;
let panToken: Actor;
let pan: string;
let doc: string;
let support: string;
let p0: string;

const events = (id: string, types: string[]) =>
  t.adminDb
    .select()
    .from(domainEvents)
    .where(and(eq(domainEvents.subjectId, id), inArray(domainEvents.type, types)))
    .orderBy(asc(domainEvents.occurredAt), asc(domainEvents.id));

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  doc = (await createProduct(t.db, owner, { name: '文档', key: 'DOC' })).id;
  ed = await asMember(t.db, owner, '编辑甲');
  peer = await asMember(t.db, owner, '同事乙');
  docViewer = await asMember(t.db, owner, '文档只读丙');
  await setProductRole(t.db, owner, doc, docViewer.memberId, 'viewer');
  guest = await asMember(t.db, owner, '外部丁', 'guest');
  await setProductRole(t.db, owner, pan, guest.memberId, 'editor');
  panToken = { ...owner, tokenId: '00000000-0000-0000-0000-0000000000f2', tokenScope: { products: [pan], access: 'write' } };
  const fields = await listFields(t.db, owner);
  support = fields.find((f) => f.key === 'work_type')!.options.find((o) => o.key === 'support')!.id;
  p0 = fields.find((f) => f.key === 'priority')!.options.find((o) => o.key === 'p0')!.id;
});
afterAll(() => t.cleanup());

describe('编号', () => {
  it('W-n 的显示与解析（不区分大小写）', () => {
    expect(workItemDisplayKey(12)).toBe('W-12');
    expect(parseWorkItemKey('w-12')).toBe(12);
    expect(parseWorkItemKey(' W-3 ')).toBe(3);
    expect(parseWorkItemKey('PAN-3')).toBeNull();
  });
});

describe('工作项', () => {
  it('新建：按组织连续编号；工作类型、负责人、日期；记事件；按编号打开；校验工作类型与日期', async () => {
    await expect(createWorkItem(t.db, ed, { title: '错的类型', workTypeOptionId: p0 })).rejects.toMatchObject({ code: 'invalid', message: '选项不属于「工作类型」' });
    await expect(createWorkItem(t.db, ed, { title: '错的日期', startedOn: '2026-13-01' })).rejects.toMatchObject({ code: 'invalid', message: '启动日期格式应为 YYYY-MM-DD' });
    const w1 = await createWorkItem(t.db, ed, { title: ' 协助客服排查 ', workTypeOptionId: support, ownerMemberId: ed.memberId, startedOn: '2026-10-08', expectedDate: '2026-10-20' });
    expect(w1).toMatchObject({
      number: 1,
      displayKey: 'W-1',
      title: '协助客服排查',
      product: null,
      status: 'active',
      startedOn: '2026-10-08',
      expectedDate: '2026-10-20',
      doneAt: null,
      paused: null,
      workType: { id: support, label: '技术支持' },
      owner: { id: ed.memberId, displayName: '编辑甲' },
      createdBy: { id: ed.memberId, displayName: '编辑甲' },
      access: { view: true, edit: true, progress: true, manage: false },
      blockers: [],
    });
    const w2 = await createWorkItem(t.db, owner, { title: '对接渠道', productId: pan });
    expect(w2).toMatchObject({ displayKey: 'W-2', product: { id: pan, key: 'PAN', name: '网盘' } });
    expect((await getWorkItemByKey(t.db, ed, 'w-1')).id).toBe(w1.id);
    expect((await events(w1.id, ['work_item.created']))[0]!.payload).toMatchObject({ number: 1, title: '协助客服排查', ownerMemberId: ed.memberId });
    for (const key of ['W-99', 'PAN-1']) await expect(getWorkItemByKey(t.db, ed, key)).rejects.toMatchObject({ code: 'not_found', message: '工作项不存在' });
  });

  it('描述里的 @ 与负责人变化写进事件', async () => {
    const w = await createWorkItem(t.db, ed, { title: '描述', description: `请 ${mentionMarkup(peer.memberId, '同事乙')} 看` });
    expect((await events(w.id, ['work_item.created']))[0]!.payload).toMatchObject({ mentionedMemberIds: [peer.memberId] });
    await updateWorkItem(t.db, ed, w.id, { description: `请 ${mentionMarkup(peer.memberId, '同事乙')} ${mentionMarkup(owner.memberId, 'Owner')} 看`, ownerMemberId: peer.memberId });
    expect((await events(w.id, ['work_item.updated']))[0]!.payload).toMatchObject({
      mentionedMemberIds: [owner.memberId],
      changes: expect.arrayContaining([{ field: 'ownerMemberId', old: null, new: peer.memberId }]),
    });
  });

  it('不关联产品：非访客成员可以查看；负责人、创建人、组织管理员可以修改；访客、限定产品的 Token 看不到；只读 Token 不能修改与新建', async () => {
    const w = await createWorkItem(t.db, ed, { title: '不关联产品的工作' });
    expect((await getWorkItemByKey(t.db, peer, w.displayKey)).access).toEqual({ view: true, edit: false, progress: true, manage: false });
    await expect(updateWorkItem(t.db, peer, w.id, { title: '改名' })).rejects.toMatchObject({ code: 'forbidden', message: '只有负责人、创建人或组织管理员可以修改这个工作项' });
    await updateWorkItem(t.db, ed, w.id, { ownerMemberId: peer.memberId });
    expect((await updateWorkItem(t.db, peer, w.id, { title: '负责人改名' })).title).toBe('负责人改名');
    expect((await getWorkItemByKey(t.db, owner, w.displayKey)).access).toEqual({ view: true, edit: true, progress: true, manage: true });
    for (const a of [guest, panToken]) await expect(getWorkItemByKey(t.db, a, w.displayKey)).rejects.toMatchObject({ code: 'not_found' });
    await expect(updateWorkItem(t.db, readOnlyToken(owner), w.id, { title: '只读' })).rejects.toMatchObject({ code: 'forbidden' });
    for (const a of [guest, readOnlyToken(owner)]) await expect(createWorkItem(t.db, a, { title: '新建' })).rejects.toMatchObject({ code: 'forbidden', message: '没有新建工作项的权限' });
  });

  it('关联产品：权限随产品角色；只读成员只能看，限定产品的 Token 只能看到范围内的产品', async () => {
    const w = await createWorkItem(t.db, ed, { title: '文档产品的工作', productId: doc });
    expect((await getWorkItemByKey(t.db, docViewer, w.displayKey)).access).toEqual({ view: true, edit: false, progress: false, manage: false });
    expect((await getWorkItemByKey(t.db, ed, w.displayKey)).access).toEqual({ view: true, edit: true, progress: true, manage: false });
    expect((await getWorkItemByKey(t.db, owner, w.displayKey)).access.manage).toBe(true);
    await expect(updateWorkItem(t.db, docViewer, w.id, { title: '改名' })).rejects.toMatchObject({ code: 'forbidden', message: '权限不足' });
    await expect(createWorkItemBlocker(t.db, docViewer, w.id, { description: '只读成员' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(getWorkItemByKey(t.db, panToken, w.displayKey)).rejects.toMatchObject({ code: 'not_found' });
    await expect(createWorkItem(t.db, docViewer, { title: '无权新建', productId: doc })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('改关联产品的权限：目标位置也要有修改权限', async () => {
    const w = await createWorkItem(t.db, peer, { title: '别人的产品工作', productId: pan });
    await expect(updateWorkItem(t.db, ed, w.id, { productId: null })).rejects.toMatchObject({
      code: 'forbidden',
      message: '只有负责人、创建人或组织管理员可以把工作项改为不关联产品',
    });
    await expect(updateWorkItem(t.db, docViewer, w.id, { productId: doc })).rejects.toMatchObject({ code: 'forbidden', message: '权限不足' });
    await expect(updateWorkItem(t.db, guest, w.id, { productId: doc })).rejects.toMatchObject({ code: 'not_found', message: '产品不存在' });
    expect((await updateWorkItem(t.db, ed, w.id, { productId: doc })).product).toMatchObject({ key: 'DOC' });
    expect((await updateWorkItem(t.db, peer, w.id, { productId: null })).product).toBeNull();
    const last = (await events(w.id, ['work_item.updated'])).at(-1)!;
    expect(last.payload).toMatchObject({ changes: [{ field: 'productId', old: doc, new: null }] });
    expect(last.productId).toBeNull();
  });

  it('状态与暂停：改成当前状态、重复暂停、没有暂停时恢复、已完成时暂停都报错，不写重复事件；改状态不自动恢复', async () => {
    const w = await createWorkItem(t.db, ed, { title: '状态测试' });
    await expect(setWorkItemStatus(t.db, ed, w.id, 'active')).rejects.toMatchObject({ code: 'invalid', message: '工作项已处于该状态' });
    await expect(resumeWorkItem(t.db, ed, w.id)).rejects.toMatchObject({ code: 'invalid', message: '工作项没有暂停' });
    expect((await pauseWorkItem(t.db, ed, w.id, { reason: '等对方排期' })).paused).toMatchObject({ reason: '等对方排期' });
    await expect(pauseWorkItem(t.db, ed, w.id, { reason: '再暂停' })).rejects.toMatchObject({ code: 'invalid', message: '工作项已暂停' });
    const done = await setWorkItemStatus(t.db, ed, w.id, 'done');
    expect(done.status).toBe('done');
    expect(done.doneAt).not.toBeNull();
    expect(done.paused).not.toBeNull();
    await resumeWorkItem(t.db, ed, w.id);
    await expect(pauseWorkItem(t.db, ed, w.id, { reason: '完成后暂停' })).rejects.toMatchObject({ code: 'invalid', message: '只有进行中的工作项可以暂停' });
    expect((await setWorkItemStatus(t.db, ed, w.id, 'active')).doneAt).toBeNull();
    expect((await events(w.id, ['work_item.paused', 'work_item.resumed', 'work_item.status_changed'])).map((e) => e.type)).toEqual([
      'work_item.paused',
      'work_item.status_changed',
      'work_item.resumed',
      'work_item.status_changed',
    ]);
  });

  it('删除：只有能修改的人可以删；删除后按编号打不开，也不能再改状态', async () => {
    const w = await createWorkItem(t.db, ed, { title: '要删除的' });
    await expect(deleteWorkItem(t.db, peer, w.id)).rejects.toMatchObject({ code: 'forbidden' });
    await deleteWorkItem(t.db, ed, w.id);
    await expect(getWorkItemByKey(t.db, ed, w.displayKey)).rejects.toMatchObject({ code: 'not_found' });
    await expect(setWorkItemStatus(t.db, ed, w.id, 'done')).rejects.toMatchObject({ code: 'not_found', message: '工作项不存在' });
    expect(await events(w.id, ['work_item.deleted'])).toHaveLength(1);
  });

  it('阻塞项挂在工作项上：能写进展的人可以新建与解除；详情列出；事件挂在工作项上', async () => {
    const w = await createWorkItem(t.db, ed, { title: '阻塞测试' });
    const b = await createWorkItemBlocker(t.db, peer, w.id, { description: ' 等对方回复 ' });
    expect(b).toMatchObject({ description: '等对方回复', status: 'active' });
    expect((await getWorkItemByKey(t.db, ed, w.displayKey)).blockers.map((x) => x.description)).toEqual(['等对方回复']);
    await expect(createWorkItemBlocker(t.db, readOnlyToken(owner), w.id, { description: '只读' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(resolveBlocker(t.db, guest, b.id)).rejects.toMatchObject({ code: 'not_found' });
    expect((await resolveBlocker(t.db, peer, b.id)).status).toBe('resolved');
    expect((await events(w.id, ['blocker.created', 'blocker.resolved'])).map((e) => [e.type, e.subjectType])).toEqual([
      ['blocker.created', 'work_item'],
      ['blocker.resolved', 'work_item'],
    ]);
  });
});
