import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkItemResults,
  checkItemSignoffs,
  iterations,
  members,
  organizations,
  products,
  requirements,
} from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import { newId } from '../src/ids';
import { createTestDb } from './db';

let t: Awaited<ReturnType<typeof createTestDb>>;
const orgA = newId();
const orgB = newId();
const productA = newId();
const memberA = newId();

beforeAll(async () => {
  t = await createTestDb();
  await t.adminDb.insert(organizations).values([
    { id: orgA, slug: 'a', name: 'A' },
    { id: orgB, slug: 'b', name: 'B' },
  ]);
  await t.adminDb.insert(products).values({ id: productA, orgId: orgA, key: 'AA', name: 'A 产品' });
  await t.adminDb.insert(members).values({ id: memberA, orgId: orgA, displayName: '甲', orgRole: 'member' });
});
afterAll(() => t.cleanup());

describe('P1-A 数据模型', () => {
  it('需求受行级安全约束', async () => {
    await withOrg(t.db, orgA, (tx) =>
      tx.insert(requirements).values({ orgId: orgA, productId: productA, number: 1, title: '甲需求', stateKey: 'backlog' }),
    );
    expect(await withOrg(t.db, orgA, (tx) => tx.select().from(requirements))).toHaveLength(1);
    expect(await withOrg(t.db, orgB, (tx) => tx.select().from(requirements))).toHaveLength(0);
  });

  it('同一产品内需求编号唯一', async () => {
    await expect(
      withOrg(t.db, orgA, (tx) =>
        tx.insert(requirements).values({ orgId: orgA, productId: productA, number: 1, title: '重复编号', stateKey: 'backlog' }),
      ),
    ).rejects.toThrow();
  });

  it('常规迭代时间不能重叠，首尾相接可以', async () => {
    const base = { orgId: orgA, productId: productA, type: 'regular' as const, status: 'planning' as const };
    await withOrg(t.db, orgA, (tx) =>
      tx.insert(iterations).values([
        { ...base, name: '一', startDate: '2026-07-08', endDate: '2026-07-21' },
        { ...base, name: '二', startDate: '2026-07-21', endDate: '2026-08-04' },
      ]),
    );
    await expect(
      withOrg(t.db, orgA, (tx) => tx.insert(iterations).values({ ...base, name: '三', startDate: '2026-07-10', endDate: '2026-07-15' })),
    ).rejects.toThrow();
  });

  it('组织级专项不受重叠限制，且不属于产品', async () => {
    await withOrg(t.db, orgA, (tx) =>
      tx.insert(iterations).values([
        { orgId: orgA, productId: null, type: 'special', status: 'active', name: '专项一', startDate: '2026-07-10', endDate: '2026-07-30' },
        { orgId: orgA, productId: null, type: 'special', status: 'active', name: '专项二', startDate: '2026-07-10', endDate: '2026-07-30' },
      ]),
    );
    await expect(
      withOrg(t.db, orgA, (tx) =>
        tx.insert(iterations).values({ orgId: orgA, productId: productA, type: 'special', status: 'active', name: '错', startDate: '2026-01-01', endDate: '2026-01-02' }),
      ),
    ).rejects.toThrow();
  });

  it('会签记录可以记录代签的实际操作人', async () => {
    const [req] = await withOrg(t.db, orgA, (tx) => tx.select().from(requirements));
    const [result] = await withOrg(t.db, orgA, (tx) =>
      tx
        .insert(checkItemResults)
        .values({ orgId: orgA, targetType: 'requirement', targetId: req!.id, itemKey: 'design', state: 'in_progress' })
        .returning(),
    );
    const [s] = await withOrg(t.db, orgA, (tx) =>
      tx
        .insert(checkItemSignoffs)
        .values({ orgId: orgA, resultId: result!.id, signerMemberId: memberA, actedByMemberId: memberA, signerRuleIndex: 0, decision: 'passed' })
        .returning(),
    );
    expect(s!.actedByMemberId).toBe(memberA);
  });

  it('新表全部开启了行级安全', async () => {
    const rows = await t.adminDb.execute(sql`
      select relname from pg_class
      where relname in ('structure_nodes','iterations','iteration_scope_snapshots','releases','requirements',
        'requirement_releases','field_values','requirement_assignments','requirement_relations','state_transitions',
        'blockers','check_item_results','check_item_signoffs','tasks','comments','comment_reads','entity_aliases')
        and relrowsecurity`);
    expect(rows).toHaveLength(17);
  });
});
