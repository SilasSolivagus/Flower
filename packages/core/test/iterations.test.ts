import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blockers, domainEvents, iterationScopeSnapshots, releases, requirements } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import type { Actor } from '../src/domain-types';
import {
  createIteration,
  deleteIteration,
  getIteration,
  getIterationScope,
  listIterations,
  setIterationStatus,
  updateIteration,
} from '../src/iterations/iterations';
import { createRequirement } from '../src/requirements/requirements';
import { setProductRole, createProduct } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let pm: Actor;
let editor: Actor;
let viewer: Actor;
let readToken: Actor;
let pan: string;
let doc: string;

const putInIteration = (requirementId: string, iterationId: string | null) =>
  withOrg(t.db, owner.orgId, (tx) => tx.update(requirements).set({ iterationId }).where(eq(requirements.id, requirementId)));
const setState = (requirementId: string, stateKey: string) =>
  withOrg(t.db, owner.orgId, (tx) => tx.update(requirements).set({ stateKey }).where(eq(requirements.id, requirementId)));
const eventsOf = (subjectId: string) => withOrg(t.db, owner.orgId, (tx) => tx.select().from(domainEvents).where(eq(domainEvents.subjectId, subjectId)));
const snapshotsOf = (iterationId: string) =>
  withOrg(t.db, owner.orgId, (tx) => tx.select().from(iterationScopeSnapshots).where(eq(iterationScopeSnapshots.iterationId, iterationId)));
const regular = (productId: string, name: string, startDate: string, endDate: string) =>
  ({ type: 'regular' as const, productId, name, startDate, endDate });

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  doc = (await createProduct(t.db, owner, { name: '文档', key: 'DOC' })).id;
  pm = await asMember(t.db, owner, '产品经理甲');
  await setProductRole(t.db, owner, pan, pm.memberId, 'admin');
  editor = await asMember(t.db, owner, '开发乙');
  viewer = await asMember(t.db, owner, '只读丙');
  await setProductRole(t.db, owner, pan, viewer.memberId, 'viewer');
  readToken = { ...owner, tokenId: '00000000-0000-0000-0000-0000000000f1', tokenScope: { products: 'all', access: 'read' } };
});
afterAll(() => t.cleanup());

describe('新建与修改迭代', () => {
  it('产品编辑及以上可以新建常规迭代；只读成员、只读 Token 不行', async () => {
    const created = await createIteration(t.db, pm, {
      ...regular(pan, '迭代0701', '2026-07-01', '2026-07-15'),
      milestones: [
        { label: '发布', date: '2026-07-15' },
        { label: '开发开始', date: '2026-07-03' },
      ],
    });
    expect(created).toMatchObject({ type: 'regular', product: { key: 'PAN' }, status: 'planning', baselineEndDate: null, requirementCount: 0, canManage: true });
    expect(created.milestones.map((m) => m.label)).toEqual(['开发开始', '发布']);
    const input = regular(pan, '越权迭代', '2026-06-01', '2026-06-10');
    const byEditor = await createIteration(t.db, editor, input);
    expect(byEditor).toMatchObject({ type: 'regular', status: 'planning', canManage: true });
    await expect(createIteration(t.db, viewer, input)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(createIteration(t.db, readToken, input)).rejects.toMatchObject({ code: 'forbidden' });
    expect((await eventsOf(created.id)).map((e) => e.type)).toEqual(['iteration.created']);
  });

  it('同一产品的常规迭代不能重叠；结束日与下一迭代开始日相同可以；其他产品不受影响', async () => {
    await expect(createIteration(t.db, owner, regular(pan, '重叠迭代', '2026-07-10', '2026-07-20'))).rejects.toMatchObject({
      code: 'conflict',
      message: '与已有迭代时间重叠',
    });
    await createIteration(t.db, owner, regular(pan, '迭代0715', '2026-07-15', '2026-07-29'));
    await createIteration(t.db, owner, regular(doc, '文档迭代', '2026-07-10', '2026-07-20'));
  });

  it('专项只有组织管理员可以新建，可以和常规迭代重叠', async () => {
    const sp = await createIteration(t.db, owner, { type: 'special', name: '专业空间优化', startDate: '2026-07-01', endDate: '2026-09-30' });
    expect(sp).toMatchObject({ type: 'special', product: null, canManage: true });
    await expect(createIteration(t.db, pm, { type: 'special', name: '越权专项', startDate: '2026-07-01', endDate: '2026-07-02' })).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('校验名称、日期与归属', async () => {
    await expect(createIteration(t.db, owner, regular(pan, '倒序', '2026-08-10', '2026-08-01'))).rejects.toMatchObject({ code: 'invalid' });
    await expect(createIteration(t.db, owner, regular(pan, '不存在的日期', '2026-02-30', '2026-03-01'))).rejects.toMatchObject({ code: 'invalid' });
    await expect(createIteration(t.db, owner, regular(pan, '   ', '2026-08-01', '2026-08-02'))).rejects.toMatchObject({ code: 'invalid' });
    await expect(createIteration(t.db, owner, { type: 'regular', name: '缺产品', startDate: '2026-08-01', endDate: '2026-08-02' })).rejects.toMatchObject({
      code: 'invalid',
    });
    await expect(
      createIteration(t.db, owner, { type: 'special', productId: pan, name: '专项带产品', startDate: '2026-08-01', endDate: '2026-08-02' }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('修改名称与里程碑并记录变更；改到重叠日期被拒绝；只读成员不能改', async () => {
    const target = (await listIterations(t.db, owner, { productId: pan })).find((i) => i.name === '迭代0701')!;
    const updated = await updateIteration(t.db, pm, target.id, { name: '迭代0701（改）', milestones: [] });
    expect(updated).toMatchObject({ name: '迭代0701（改）', milestones: [] });
    const ev = (await eventsOf(target.id)).find((e) => e.type === 'iteration.updated')!;
    expect(ev.payload).toMatchObject({ changes: [{ field: 'name', old: '迭代0701', new: '迭代0701（改）' }, { field: 'milestones' }] });
    await expect(updateIteration(t.db, pm, target.id, { endDate: '2026-07-20' })).rejects.toMatchObject({ code: 'conflict' });
    await expect(updateIteration(t.db, viewer, target.id, { name: '越权' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(updateIteration(t.db, readToken, target.id, { name: '越权' })).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('状态流转与承诺快照', () => {
  it('开始时锁定基线并记录承诺范围；之后改结束日期不动基线；结束后不能再改', async () => {
    const it2 = await createIteration(t.db, owner, regular(pan, '迭代0801', '2026-08-01', '2026-08-14'));
    const a = await createRequirement(t.db, owner, pan, { title: '批量重命名' });
    const b = await createRequirement(t.db, owner, pan, { title: '回收站搜索' });
    await putInIteration(a.id, it2.id);
    await putInIteration(b.id, it2.id);
    await expect(setIterationStatus(t.db, owner, it2.id, 'done')).rejects.toMatchObject({ code: 'invalid' });
    await expect(setIterationStatus(t.db, viewer, it2.id, 'active')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(setIterationStatus(t.db, readToken, it2.id, 'active')).rejects.toMatchObject({ code: 'forbidden' });

    // 产品编辑及以上也能推进状态（不影响下面用 pm 实际推进 it2 的流程）。
    const editorCheck = await createIteration(t.db, owner, regular(pan, '编辑者权限检查', '2026-08-20', '2026-08-25'));
    expect((await setIterationStatus(t.db, editor, editorCheck.id, 'active')).status).toBe('active');

    const active = await setIterationStatus(t.db, pm, it2.id, 'active');
    expect(active).toMatchObject({ status: 'active', baselineEndDate: '2026-08-14', requirementCount: 2 });
    expect((await snapshotsOf(it2.id)).map((s) => s.requirementId).sort()).toEqual([a.id, b.id].sort());
    const ev = (await eventsOf(it2.id)).find((e) => e.type === 'iteration.status_changed')!;
    expect(ev.payload).toMatchObject({ changes: [{ field: 'status', old: 'planning', new: 'active' }], snapshotCount: 2 });

    expect((await updateIteration(t.db, pm, it2.id, { endDate: '2026-08-15' })).baselineEndDate).toBe('2026-08-14');
    await expect(setIterationStatus(t.db, pm, it2.id, 'planning')).rejects.toMatchObject({ code: 'invalid' });
    expect((await setIterationStatus(t.db, pm, it2.id, 'done')).status).toBe('done');
    await expect(setIterationStatus(t.db, pm, it2.id, 'canceled')).rejects.toMatchObject({ code: 'invalid' });
    await expect(updateIteration(t.db, pm, it2.id, { name: '已结束还想改' })).rejects.toMatchObject({ code: 'invalid' });
    expect(await snapshotsOf(it2.id)).toHaveLength(2);
  });

  it('已有承诺快照（迁移数据）时开始迭代不重复写入', async () => {
    const it3 = await createIteration(t.db, owner, regular(pan, '迭代0901', '2026-09-01', '2026-09-14'));
    const c = await createRequirement(t.db, owner, pan, { title: '迁移来的需求' });
    await putInIteration(c.id, it3.id);
    await withOrg(t.db, owner.orgId, (tx) =>
      tx.insert(iterationScopeSnapshots).values({ orgId: owner.orgId, iterationId: it3.id, requirementId: c.id, snapshotKind: 'committed' }),
    );
    const d = await createRequirement(t.db, owner, pan, { title: '开始前加入的需求' });
    await putInIteration(d.id, it3.id);
    await setIterationStatus(t.db, owner, it3.id, 'active');
    expect((await snapshotsOf(it3.id)).map((s) => s.requirementId)).toEqual([c.id]);
    const ev = (await eventsOf(it3.id)).find((e) => e.type === 'iteration.status_changed')!;
    expect(ev.payload).toMatchObject({ snapshotCount: 0 });
  });

  it('规划中和进行中的迭代都可以取消', async () => {
    const x = await createIteration(t.db, owner, regular(pan, '迭代0915', '2026-09-15', '2026-09-20'));
    expect((await setIterationStatus(t.db, owner, x.id, 'canceled')).status).toBe('canceled');

    const y = await createIteration(t.db, owner, regular(pan, '迭代0921', '2026-09-21', '2026-09-25'));
    expect((await setIterationStatus(t.db, owner, y.id, 'active')).status).toBe('active');
    expect((await setIterationStatus(t.db, owner, y.id, 'canceled')).status).toBe('canceled');
  });
});

describe('列表、详情与范围对比', () => {
  it('列表给出需求数与已完成数；详情列出需求、负责人与未解除的阻塞项数', async () => {
    const it4 = await createIteration(t.db, owner, regular(pan, '迭代1001', '2026-10-01', '2026-10-14'));
    const e = await createRequirement(t.db, owner, pan, { title: '上传限速', ownerMemberId: editor.memberId });
    const f = await createRequirement(t.db, owner, pan, { title: '下载限速' });
    await putInIteration(e.id, it4.id);
    await putInIteration(f.id, it4.id);
    await setState(f.id, 'done');
    await withOrg(t.db, owner.orgId, (tx) =>
      tx.insert(blockers).values([
        { orgId: owner.orgId, requirementId: e.id, description: '等待存储接口' },
        { orgId: owner.orgId, requirementId: e.id, description: '已解决的阻塞', status: 'resolved' },
      ]),
    );
    const view = (await listIterations(t.db, owner, { productId: pan })).find((i) => i.id === it4.id)!;
    expect(view).toMatchObject({ requirementCount: 2, doneCount: 1 });
    const detail = await getIteration(t.db, viewer, it4.id);
    expect(detail.canManage).toBe(false);
    expect(detail.requirements.map((r) => [r.displayKey, r.title, r.state.category, r.activeBlockers, r.canEdit])).toEqual([
      [e.displayKey, '上传限速', 'backlog', 1, false],
      [f.displayKey, '下载限速', 'completed', 0, false],
    ]);
    expect(detail.requirements[0]!.owner).toEqual({ id: editor.memberId, displayName: '开发乙' });
    expect((await getIteration(t.db, editor, it4.id)).requirements[0]!.canEdit).toBe(true);
  });

  it('专项中的需求只列出操作者能看到的产品；看不到任何产品的访客看不到专项', async () => {
    const sp = (await listIterations(t.db, owner)).find((i) => i.name === '专业空间优化')!;
    const g = await createRequirement(t.db, owner, pan, { title: '空间容量提醒' });
    const h = await createRequirement(t.db, owner, doc, { title: '文档空间统计' });
    await putInIteration(g.id, sp.id);
    await putInIteration(h.id, sp.id);
    expect((await getIteration(t.db, owner, sp.id)).requirements.map((r) => r.title).sort()).toEqual(['文档空间统计', '空间容量提醒'].sort());
    const guest = await asMember(t.db, owner, '访客丁', 'guest');
    await setProductRole(t.db, owner, pan, guest.memberId, 'viewer');
    const seen = await getIteration(t.db, guest, sp.id);
    expect(seen.requirements.map((r) => r.title)).toEqual(['空间容量提醒']);
    expect(seen.requirementCount).toBe(1);
    await expect(listIterations(t.db, guest, { productId: doc })).rejects.toMatchObject({ code: 'not_found' });
    const outsider = await asMember(t.db, owner, '访客戊', 'guest');
    expect(await listIterations(t.db, outsider)).toEqual([]);
    await expect(getIteration(t.db, outsider, sp.id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('范围对比：承诺内已完成、承诺内未完成、中途加入、中途移出', async () => {
    const it5 = await createIteration(t.db, owner, regular(pan, '迭代1101', '2026-11-01', '2026-11-14'));
    const done = await createRequirement(t.db, owner, pan, { title: '承诺完成' });
    const open = await createRequirement(t.db, owner, pan, { title: '承诺未完成' });
    const moved = await createRequirement(t.db, owner, pan, { title: '将被移出' });
    for (const r of [done, open, moved]) await putInIteration(r.id, it5.id);
    await expect(getIterationScope(t.db, owner, it5.id)).rejects.toMatchObject({ code: 'invalid' });
    await setIterationStatus(t.db, owner, it5.id, 'active');
    await setState(done.id, 'done');
    const next = await createIteration(t.db, owner, regular(pan, '迭代1115', '2026-11-15', '2026-11-28'));
    await putInIteration(moved.id, next.id);
    const late = await createRequirement(t.db, owner, pan, { title: '中途加入的需求' });
    await putInIteration(late.id, it5.id);

    const scope = await getIterationScope(t.db, viewer, it5.id);
    expect(scope.hasSnapshot).toBe(true);
    expect(scope.snapshotAt).toBeInstanceOf(Date);
    expect(scope.committedDone.map((x) => x.title)).toEqual(['承诺完成']);
    expect(scope.committedOpen.map((x) => x.title)).toEqual(['承诺未完成']);
    expect(scope.addedLater.map((x) => x.title)).toEqual(['中途加入的需求']);
    expect(scope.removed).toEqual([expect.objectContaining({ title: '将被移出', currentIteration: { id: next.id, name: '迭代1115' } })]);
  });

  it('没有承诺快照时 hasSnapshot 为 false，当前需求都放在 addedLater', async () => {
    const it6 = await createIteration(t.db, owner, regular(pan, '迭代1201', '2026-12-01', '2026-12-14'));
    await setIterationStatus(t.db, owner, it6.id, 'active');
    const x = await createRequirement(t.db, owner, pan, { title: '开始后才加入' });
    await putInIteration(x.id, it6.id);
    const scope = await getIterationScope(t.db, owner, it6.id);
    expect(scope).toMatchObject({ hasSnapshot: false, snapshotAt: null, committedDone: [], committedOpen: [], removed: [] });
    expect(scope.addedLater.map((i) => i.title)).toEqual(['开始后才加入']);
  });
});

describe('删除迭代', () => {
  it('只能删除规划中、没有需求、没有发布版本的迭代；编辑及以上可以删除，只读不行；删除后同一时间段可以重新建', async () => {
    const empty = await createIteration(t.db, owner, regular(pan, '空迭代', '2027-01-01', '2027-01-10'));
    const withReq = await createIteration(t.db, owner, regular(pan, '有需求的迭代', '2027-01-10', '2027-01-20'));
    const r = await createRequirement(t.db, owner, pan, { title: '占位需求' });
    await putInIteration(r.id, withReq.id);
    await expect(deleteIteration(t.db, pm, withReq.id)).rejects.toMatchObject({ code: 'invalid', message: '迭代中还有需求，请先移出' });
    await expect(deleteIteration(t.db, viewer, empty.id)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(deleteIteration(t.db, readToken, empty.id)).rejects.toMatchObject({ code: 'forbidden' });

    await deleteIteration(t.db, editor, empty.id);
    expect((await listIterations(t.db, owner, { productId: pan })).some((i) => i.id === empty.id)).toBe(false);
    await expect(getIteration(t.db, owner, empty.id)).rejects.toMatchObject({ code: 'not_found' });
    expect((await eventsOf(empty.id)).map((e) => e.type)).toContain('iteration.deleted');
    await createIteration(t.db, owner, regular(pan, '重建的迭代', '2027-01-01', '2027-01-10'));

    const withRelease = await createIteration(t.db, owner, regular(pan, '有版本的迭代', '2027-02-01', '2027-02-10'));
    await withOrg(t.db, owner.orgId, (tx) => tx.insert(releases).values({ orgId: owner.orgId, productId: pan, versionName: '9.0.0', iterationId: withRelease.id }));
    await expect(deleteIteration(t.db, owner, withRelease.id)).rejects.toMatchObject({ code: 'invalid', message: '迭代下还有发布版本，请先改到其他迭代' });

    const finished = (await listIterations(t.db, owner, { productId: pan })).find((i) => i.name === '迭代0801')!;
    await expect(deleteIteration(t.db, owner, finished.id)).rejects.toMatchObject({ code: 'invalid', message: '只能删除规划中的迭代' });
  });
});
