import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadProductFlow, orgTimeZone } from '../src/dashboard/flow';
import { organizations, products, requirements } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import type { Actor } from '../src/domain-types';
import { createRequirement } from '../src/requirements/requirements';
import { createProduct } from '../src/tenancy/products';
import { rewriteHistory } from './dashboard-helpers';
import { createTestDb } from './db';
import { seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let pan: string;
let bare: string;
let r1: string;
let r2: string;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  bare = (await createProduct(t.db, owner, { name: '无流程', key: 'BARE' })).id;
  await t.adminDb.update(products).set({ workflowVersionId: null }).where(eq(products.id, bare));
  r1 = (await createRequirement(t.db, owner, pan, { title: '需求一' })).id;
  r2 = (await createRequirement(t.db, owner, pan, { title: '需求二' })).id;
  const r3 = (await createRequirement(t.db, owner, pan, { title: '已删除的需求' })).id;
  // 北京时间 09-03 00:30 进入进行中，UTC 仍是 09-02
  await rewriteHistory(t.adminDb, owner.orgId, r1, '2026-09-01T10:00:00+08:00', [
    ['doing', '2026-09-03T00:30:00+08:00'],
    ['done', '2026-09-05T10:00:00+08:00'],
  ]);
  await t.adminDb.update(requirements).set({ deletedAt: new Date() }).where(eq(requirements.id, r3));
});
afterAll(() => t.cleanup());

describe('读取需求与流转', () => {
  it('只读出本产品未删除的需求与其流转；状态类别按产品流程，未知状态按 backlog', async () => {
    const flow = await withOrg(t.db, owner.orgId, (tx) => loadProductFlow(tx, pan, 'Asia/Shanghai'));
    expect(flow.productKey).toBe('PAN');
    expect(flow.states.map((s) => [s.key, s.category])).toEqual([
      ['backlog', 'backlog'],
      ['todo', 'unstarted'],
      ['doing', 'started'],
      ['done', 'completed'],
      ['canceled', 'canceled'],
    ]);
    expect(flow.categoryOf('doing')).toBe('started');
    expect(flow.categoryOf('missing')).toBe('backlog');
    expect(flow.requirements.map((r) => r.id).sort()).toEqual([r1, r2].sort());
    const one = flow.requirements.find((r) => r.id === r1)!;
    expect(one.stateKey).toBe('done');
    expect(one.transitions.map((x) => [x.toState, x.date])).toEqual([
      ['backlog', '2026-09-01'],
      ['doing', '2026-09-03'],
      ['done', '2026-09-05'],
    ]);
    expect(flow.requirements.find((r) => r.id === r2)!.transitions.map((x) => x.toState)).toEqual(['backlog']);
    expect(flow.meta.get(r1)).toEqual({ id: r1, number: 1, title: '需求一', stateKey: 'done', iterationId: null });
    expect(flow.checkItems).toEqual([]);
  });

  it('日期按传入的时区换算', async () => {
    const flow = await withOrg(t.db, owner.orgId, (tx) => loadProductFlow(tx, pan, 'UTC'));
    expect(flow.requirements.find((r) => r.id === r1)!.transitions[1]!.date).toBe('2026-09-02');
  });

  it('产品没有流程时状态为空，所有状态按 backlog', async () => {
    const flow = await withOrg(t.db, owner.orgId, (tx) => loadProductFlow(tx, bare, 'Asia/Shanghai'));
    expect(flow.states).toEqual([]);
    expect(flow.categoryOf('done')).toBe('backlog');
    expect(flow.requirements).toEqual([]);
  });

  it('组织时区：未设置或无效时为 Asia/Shanghai，设置后按设置', async () => {
    const tz = () => withOrg(t.db, owner.orgId, (tx) => orgTimeZone(tx, owner.orgId));
    expect(await tz()).toBe('Asia/Shanghai');
    await t.adminDb.update(organizations).set({ settings: { timezone: 'America/New_York' } }).where(eq(organizations.id, owner.orgId));
    expect(await tz()).toBe('America/New_York');
    await t.adminDb.update(organizations).set({ settings: { timezone: 'Mars/Base' } }).where(eq(organizations.id, owner.orgId));
    expect(await tz()).toBe('Asia/Shanghai');
    await t.adminDb.update(organizations).set({ settings: {} }).where(eq(organizations.id, owner.orgId));
  });
});
