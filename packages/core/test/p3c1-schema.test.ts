import { readFileSync } from 'node:fs';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blockers, fieldDefinitions, fieldOptions, organizations, progressUpdates, requirements, stateTransitions, workItems } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import { createWorkflowTemplate, setProductWorkflowVersion } from '../src/definitions/workflows';
import type { WorkflowBody } from '../src/definitions/workflow-schema';
import type { Actor } from '../src/domain-types';
import { newId } from '../src/ids';
import { createRequirement } from '../src/requirements/requirements';
import { createProduct } from '../src/tenancy/products';
import { backfillTrackedSinceTx } from '../src/tracking/backfill';
import { createTestDb } from './db';
import { seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let productId: string;
let reqId: string;
const orgB = newId();

const STATES: WorkflowBody['states'] = [
  { key: 'backlog', label: '收集', color: '#94a3b8', order: 1, group: '', category: 'backlog' },
  { key: 'design', label: '设计中', color: '#60a5fa', order: 2, group: '', category: 'unstarted' },
  { key: 'dev', label: '开发中', color: '#f59e0b', order: 3, group: '', category: 'started' },
  { key: 'done', label: '已上线', color: '#10b981', order: 4, group: '', category: 'completed' },
];

/** 迁移 0020 除第一段（开启 RLS）以外的语句：回填加入跟进时间、补齐内置字段。 */
const BACKFILL = readFileSync(new URL('../migrations/0020_p3c1_tracking.sql', import.meta.url), 'utf8')
  .split('--> statement-breakpoint')
  .map((s) => s.trim())
  .filter(Boolean)
  .slice(1);
const runMigrationBackfill = async () => {
  for (const s of BACKFILL) await t.adminDb.execute(sql.raw(s));
};

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  await t.adminDb.insert(organizations).values({ id: orgB, slug: 'b', name: 'B' });
  productId = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  const wf = await createWorkflowTemplate(t.db, owner, {
    name: '回填流程',
    body: { states: STATES, initial: 'backlog', transitions: STATES.map((s) => ({ from: '*', to: s.key, conditions: [] })), actionGates: [], checkItems: [] },
  });
  await setProductWorkflowVersion(t.db, owner, productId, wf.version.id);
  reqId = (await createRequirement(t.db, owner, productId, { title: '回填用需求' })).id;
});
afterAll(() => t.cleanup());

describe('P3-C1 数据模型', () => {
  it('工作项与进展记录受行级安全约束，各有一条策略', async () => {
    await withOrg(t.db, owner.orgId, async (tx) => {
      const [w] = await tx.insert(workItems).values({ orgId: owner.orgId, number: 1, title: '协助排查', createdBy: owner.memberId }).returning();
      await tx.insert(progressUpdates).values({ orgId: owner.orgId, workItemId: w!.id, body: '已联系对方', authorMemberId: owner.memberId });
    });
    for (const table of [workItems, progressUpdates]) {
      expect(await withOrg(t.db, owner.orgId, (tx) => tx.select().from(table))).toHaveLength(1);
      expect(await withOrg(t.db, orgB, (tx) => tx.select().from(table))).toHaveLength(0);
    }
    const [{ n }] = (await t.adminDb.execute(sql`select count(*)::int as n from pg_policies where tablename in ('work_items', 'progress_updates')`)) as unknown as [{ n: number }];
    expect(n).toBe(2);
  });

  it('默认值', async () => {
    const [r] = await t.adminDb.select().from(requirements).where(eq(requirements.id, reqId));
    expect(r).toMatchObject({ trackedSince: null, trackingOptedOut: false, expectedDate: null, pausedAt: null, pauseReason: null });
    const [w] = await t.adminDb.select().from(workItems);
    expect(w).toMatchObject({ status: 'active', productId: null, description: '', doneAt: null, pausedAt: null, deletedAt: null });
    const [o] = await t.adminDb.select().from(organizations).where(eq(organizations.id, orgB));
    expect(o!.workItemSeq).toBe(0);
  });

  it('进展记录与阻塞项恰好挂在一个对象上；工作项编号在组织内唯一', async () => {
    const [w] = await t.adminDb.select().from(workItems);
    const base = { orgId: owner.orgId, body: '进展', authorMemberId: owner.memberId };
    await expect(t.adminDb.insert(progressUpdates).values(base)).rejects.toThrow();
    await expect(t.adminDb.insert(progressUpdates).values({ ...base, requirementId: reqId, workItemId: w!.id })).rejects.toThrow();
    await t.adminDb.insert(progressUpdates).values({ ...base, requirementId: reqId });
    await expect(t.adminDb.insert(blockers).values({ orgId: owner.orgId, description: '无对象' })).rejects.toThrow();
    await expect(t.adminDb.insert(blockers).values({ orgId: owner.orgId, requirementId: reqId, workItemId: w!.id, description: '两个对象' })).rejects.toThrow();
    await t.adminDb.insert(blockers).values({ orgId: owner.orgId, workItemId: w!.id, description: '等对方回复' });
    await expect(t.adminDb.insert(workItems).values({ orgId: owner.orgId, number: 1, title: '重复编号' })).rejects.toThrow();
    await t.adminDb.insert(workItems).values({ orgId: orgB, number: 1, title: '另一个组织' });
  });
});

describe('迁移 0020 的回填', () => {
  const ids: Record<string, string> = {};

  /** 改写需求的流转历史与当前状态，并清空加入跟进的时间。 */
  async function rewrite(id: string, steps: Array<[string | null, string, string]>, extra: Partial<typeof requirements.$inferInsert> = {}) {
    await t.adminDb.delete(stateTransitions).where(eq(stateTransitions.requirementId, id));
    for (const [from, to, when] of steps) {
      await t.adminDb.insert(stateTransitions).values({ orgId: owner.orgId, requirementId: id, fromState: from, toState: to, at: new Date(when) });
    }
    const last = steps.at(-1);
    await t.adminDb
      .update(requirements)
      .set({ stateKey: last?.[1] ?? 'backlog', stateChangedAt: new Date(last?.[2] ?? '2026-09-01T00:00:00Z'), trackedSince: null, trackingOptedOut: false, deletedAt: null, ...extra })
      .where(eq(requirements.id, id));
  }

  async function arrange() {
    const start: Array<[string | null, string, string]> = [[null, 'backlog', '2026-09-01T02:00:00Z']];
    await rewrite(ids.r1!, [...start, ['backlog', 'design', '2026-09-05T02:00:00Z'], ['design', 'dev', '2026-09-10T02:00:00Z']]);
    await rewrite(ids.r2!, [...start, ['backlog', 'design', '2026-09-02T02:00:00Z'], ['design', 'done', '2026-09-08T02:00:00Z'], ['done', 'dev', '2026-09-15T02:00:00Z']]);
    await rewrite(ids.r3!, start);
    await rewrite(ids.r4!, [], { stateKey: 'dev', stateChangedAt: new Date('2026-09-20T02:00:00Z') });
    await rewrite(ids.r5!, [...start, ['backlog', 'dev', '2026-09-06T02:00:00Z']], { deletedAt: new Date('2026-09-30T02:00:00Z') });
    await rewrite(ids.r6!, [...start, ['backlog', 'dev', '2026-09-06T02:00:00Z']], { trackingOptedOut: true });
    await rewrite(ids.r7!, [...start, ['backlog', 'dev', '2026-09-06T02:00:00Z']], { trackedSince: new Date('2026-08-01T02:00:00Z') });
  }

  async function trackedOf(): Promise<Record<string, string | null>> {
    const rows = await t.adminDb.select({ id: requirements.id, at: requirements.trackedSince }).from(requirements).where(inArray(requirements.id, Object.values(ids)));
    return Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, rows.find((r) => r.id === id)!.at?.toISOString() ?? null]));
  }

  const EXPECTED = {
    r1: '2026-09-05T02:00:00.000Z',
    r2: '2026-09-15T02:00:00.000Z',
    r3: null,
    r4: '2026-09-20T02:00:00.000Z',
    r5: null,
    r6: null,
    r7: '2026-08-01T02:00:00.000Z',
  };

  beforeAll(async () => {
    for (const k of ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7']) ids[k] = (await createRequirement(t.db, owner, productId, { title: `回填 ${k}` })).id;
  });

  it('取最近一次从其他类别进入未开始或进行中的时间；没有流转时取 state_changed_at；已删除、手动移出、已有值的不变；可重复执行', async () => {
    await arrange();
    await runMigrationBackfill();
    expect(await trackedOf()).toEqual(EXPECTED);
    await runMigrationBackfill();
    expect(await trackedOf()).toEqual(EXPECTED);
  });

  it('迁移工具用的 backfillTrackedSinceTx 与迁移结果一致，返回回填条数', async () => {
    await arrange();
    const n = await withOrg(t.db, owner.orgId, (tx) => backfillTrackedSinceTx(tx, owner.orgId));
    expect(await trackedOf()).toEqual(EXPECTED);
    expect(n).toBeGreaterThanOrEqual(3);
  });

  it('补齐内置字段「类型」「工作类型」与预置选项，可重复执行', async () => {
    await t.adminDb.execute(sql`delete from field_options where field_id in (select id from field_definitions where key in ('type', 'work_type'))`);
    await t.adminDb.delete(fieldDefinitions).where(inArray(fieldDefinitions.key, ['type', 'work_type']));
    await runMigrationBackfill();
    await runMigrationBackfill();
    for (const org of [owner.orgId, orgB]) {
      const defs = await t.adminDb.select().from(fieldDefinitions).where(and(eq(fieldDefinitions.orgId, org), inArray(fieldDefinitions.key, ['type', 'work_type'])));
      expect(defs.map((d) => [d.key, d.appliesTo, d.builtin, d.cardinality, d.productId]).sort()).toEqual([
        ['type', 'requirement', true, 'single', null],
        ['work_type', 'work_item', true, 'single', null],
      ]);
      const labels = async (key: string) =>
        (await t.adminDb.select().from(fieldOptions).where(eq(fieldOptions.fieldId, defs.find((d) => d.key === key)!.id))).sort((a, b) => a.sort - b.sort).map((o) => o.label);
      expect(await labels('type')).toEqual(['新功能', '体验优化', '线上问题']);
      expect(await labels('work_type')).toEqual(['技术支持', '协调对接']);
    }
  });
});
