import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { workItems } from '../src/db/schema';
import type { Actor } from '../src/domain-types';
import { newId } from '../src/ids';
import { createRequirement } from '../src/requirements/requirements';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { batchSetWorkItemStatus, listWorkItems, WORK_ITEM_BATCH_HIDDEN } from '../src/tracking/work-item-list';
import { createWorkItem, setWorkItemStatus } from '../src/tracking/work-items';
import { createTestDb } from './db';
import { asMember, seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let viewer: Actor;
let pan: string;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  viewer = await asMember(t.db, owner, '只读');
  await setProductRole(t.db, owner, pan, viewer.memberId, 'viewer');
});
afterAll(() => t.cleanup());

describe('工作项列表', () => {
  it('默认不含已完成和已取消；打开参数后不限时间都能查到；空列表合法', async () => {
    expect(await listWorkItems(t.db, owner)).toEqual([]);
    const active = await createWorkItem(t.db, owner, { title: '进行中', productId: pan });
    const done = await createWorkItem(t.db, owner, { title: '很久以前完成', productId: pan });
    await setWorkItemStatus(t.db, owner, done.id, 'done');
    await t.adminDb.update(workItems).set({ doneAt: new Date('2020-01-01T00:00:00Z') }).where(eq(workItems.id, done.id));
    const canceled = await createWorkItem(t.db, owner, { title: '已取消', productId: pan });
    await setWorkItemStatus(t.db, owner, canceled.id, 'canceled');
    const def = await listWorkItems(t.db, owner);
    expect(def.map((i) => i.displayKey)).toEqual([active.displayKey]);
    expect(def[0]).toMatchObject({ title: '进行中', stage: { key: 'active', label: '进行中' }, canWrite: true, latest: null });
    const withDone = await listWorkItems(t.db, owner, { includeDone: true });
    expect(withDone.map((i) => i.title).sort()).toEqual(['很久以前完成', '进行中']);
    const withCanceled = await listWorkItems(t.db, owner, { includeCanceled: true });
    expect(withCanceled.map((i) => i.title).sort()).toEqual(['已取消', '进行中']);
    expect(await listWorkItems(t.db, owner, { productId: newId() })).toEqual([]);
    await expect(listWorkItems(t.db, owner, { limit: 501 })).rejects.toMatchObject({ code: 'invalid', message: '一次最多查询 500 条' });
    const hidden = await listWorkItems(t.db, viewer, { includeDone: true, includeCanceled: true });
    expect(hidden.every((i) => i.canWrite === false)).toBe(true);
  });
});

describe('批量改状态', () => {
  it('全成功、已是该状态算成功、需求 id 与无权进失败、超过 50 条拒绝', async () => {
    const a = await createWorkItem(t.db, owner, { title: '甲', productId: pan });
    const b = await createWorkItem(t.db, owner, { title: '乙', productId: pan });
    await setWorkItemStatus(t.db, owner, b.id, 'done');
    const req = await createRequirement(t.db, owner, pan, { title: '这是需求' });
    const mixed = await batchSetWorkItemStatus(t.db, owner, [a.id, b.id, req.id, a.id], 'done');
    expect(mixed.updated).toBe(2);
    expect(mixed.failed).toEqual([{ id: req.id, reason: WORK_ITEM_BATCH_HIDDEN }]);
    const again = await batchSetWorkItemStatus(t.db, owner, [a.id], 'done');
    expect(again).toEqual({ updated: 1, failed: [] });
    const denied = await batchSetWorkItemStatus(t.db, viewer, [a.id], 'active');
    expect(denied.failed).toEqual([{ id: a.id, reason: WORK_ITEM_BATCH_HIDDEN }]);
    const ids = Array.from({ length: 51 }, () => newId());
    await expect(batchSetWorkItemStatus(t.db, owner, ids, 'active')).rejects.toMatchObject({ code: 'invalid', message: '一次最多修改 50 条' });
  });
});
