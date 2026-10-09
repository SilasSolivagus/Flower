import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { documentAffectedNodes, documents, organizations, products, structureNodes } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import { newId } from '../src/ids';
import { createTestDb } from './db';

let t: Awaited<ReturnType<typeof createTestDb>>;
const orgA = newId();
const orgB = newId();
const productA = newId();
const domain = newId();
const mod = newId();
const feature = newId();
const prd = newId();

beforeAll(async () => {
  t = await createTestDb();
  await t.adminDb.insert(organizations).values([
    { id: orgA, slug: 'a', name: 'A' },
    { id: orgB, slug: 'b', name: 'B' },
  ]);
  await t.adminDb.insert(products).values({ id: productA, orgId: orgA, key: 'AA', name: 'A 产品' });
  await t.adminDb.insert(structureNodes).values([
    { id: domain, orgId: orgA, productId: productA, parentId: null, depth: 1, name: '存储' },
    { id: mod, orgId: orgA, productId: productA, parentId: domain, depth: 2, name: '上传' },
    { id: feature, orgId: orgA, productId: productA, parentId: mod, depth: 3, name: '分片上传' },
  ]);
  await t.adminDb.insert(documents).values({ id: prd, orgId: orgA, productId: productA, number: 1, kind: 'change', source: 'native', title: '变更', status: 'launched' });
});
afterAll(() => t.cleanup());

describe('P2-B2 数据模型', () => {
  it('document_affected_nodes 受行级安全约束；默认待合入、没有来源小节', async () => {
    await withOrg(t.db, orgA, (tx) => tx.insert(documentAffectedNodes).values({ orgId: orgA, documentId: prd, nodeId: feature, changeType: 'added' }));
    const mine = await withOrg(t.db, orgA, (tx) => tx.select().from(documentAffectedNodes));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ mergeStatus: 'pending', sourceSections: [], mergedRevisionId: null, mergedBy: null, mergedAt: null });
    expect(await withOrg(t.db, orgB, (tx) => tx.select().from(documentAffectedNodes))).toHaveLength(0);
    const [{ n }] = (await t.adminDb.execute(sql`select count(*)::int as n from pg_policies where tablename = 'document_affected_nodes'`)) as unknown as [{ n: number }];
    expect(n).toBe(1);
  });

  it('同一份 PRD 同一个功能点只能声明一次', async () => {
    await expect(t.adminDb.insert(documentAffectedNodes).values({ orgId: orgA, documentId: prd, nodeId: feature, changeType: 'modified' })).rejects.toThrow();
  });

  it('每个模块最多一份未删除的模块文档；模块文档必须有节点，变更 PRD 不能有节点', async () => {
    const [first] = await t.adminDb
      .insert(documents)
      .values({ orgId: orgA, productId: productA, number: 2, kind: 'module', source: 'native', title: '上传', nodeId: mod, status: 'active' })
      .returning();
    await expect(
      t.adminDb.insert(documents).values({ orgId: orgA, productId: productA, number: 3, kind: 'module', source: 'native', title: '上传', nodeId: mod, status: 'active' }),
    ).rejects.toThrow();
    await t.adminDb.update(documents).set({ deletedAt: new Date() }).where(eq(documents.id, first!.id));
    await t.adminDb.insert(documents).values({ orgId: orgA, productId: productA, number: 4, kind: 'module', source: 'native', title: '上传', nodeId: mod, status: 'active' });
    await expect(t.adminDb.insert(documents).values({ orgId: orgA, productId: productA, number: 5, kind: 'module', source: 'native', title: '无节点', status: 'active' })).rejects.toThrow();
    await expect(t.adminDb.insert(documents).values({ orgId: orgA, productId: productA, number: 6, kind: 'change', source: 'native', title: '带节点', nodeId: mod })).rejects.toThrow();
  });
});
