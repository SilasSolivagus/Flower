import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attachments, documentRevisions, documents, documentTemplates, members, organizations, products, requirements } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import { newId } from '../src/ids';
import { createTestDb } from './db';

let t: Awaited<ReturnType<typeof createTestDb>>;
const orgA = newId();
const orgB = newId();
const productA = newId();
const memberA = newId();

const ext = (number: number, key: string) => ({
  orgId: orgA,
  productId: productA,
  number,
  source: 'external' as const,
  title: `外部 PRD ${number}`,
  externalUrl: `${key}?scode=x`,
  externalUrlKey: key,
  externalProvider: 'wecom' as const,
});

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

describe('P2-A 数据模型', () => {
  it('四张新表受行级安全约束', async () => {
    const [doc] = await withOrg(t.db, orgA, (tx) => tx.insert(documents).values(ext(1, 'https://doc.weixin.qq.com/doc/a')).returning());
    await withOrg(t.db, orgA, async (tx) => {
      await tx.insert(documentRevisions).values({ orgId: orgA, documentId: doc!.id, version: 1, snapshot: { title: 't', markdown: '' } });
      await tx.insert(documentTemplates).values({ orgId: orgA, name: '模板', body: '', sections: [] });
      await tx.insert(attachments).values({ orgId: orgA, targetType: 'document', targetId: doc!.id, storageKey: `${orgA}/${newId()}.png`, filename: 'a.png', mime: 'image/png', sizeBytes: 1 });
    });
    for (const table of [documents, documentRevisions, documentTemplates, attachments]) {
      expect(await withOrg(t.db, orgA, (tx) => tx.select().from(table))).toHaveLength(1);
      expect(await withOrg(t.db, orgB, (tx) => tx.select().from(table))).toHaveLength(0);
    }
  });

  it('同一产品内编号唯一；同一规范化网址只能对应一份未删除的 PRD', async () => {
    await expect(withOrg(t.db, orgA, (tx) => tx.insert(documents).values(ext(1, 'https://doc.weixin.qq.com/doc/b')))).rejects.toThrow();
    await expect(withOrg(t.db, orgA, (tx) => tx.insert(documents).values(ext(2, 'https://doc.weixin.qq.com/doc/a')))).rejects.toThrow();
    await withOrg(t.db, orgA, (tx) => tx.update(documents).set({ deletedAt: new Date() }).where(eq(documents.number, 1)));
    await withOrg(t.db, orgA, (tx) => tx.insert(documents).values(ext(2, 'https://doc.weixin.qq.com/doc/a')));
  });

  it('外部 PRD 必须有网址且没有当前修订', async () => {
    await expect(
      withOrg(t.db, orgA, (tx) => tx.insert(documents).values({ orgId: orgA, productId: productA, number: 9, source: 'external', title: '没有网址' })),
    ).rejects.toThrow();
  });

  it('需求的 change_document_id 引用 documents', async () => {
    await expect(
      withOrg(t.db, orgA, (tx) =>
        tx.insert(requirements).values({ orgId: orgA, productId: productA, number: 1, title: '挂错', stateKey: 'backlog', changeDocumentId: newId() }),
      ),
    ).rejects.toThrow();
    const [p] = await t.adminDb.select({ seq: products.documentSeq }).from(products).where(eq(products.id, productA));
    expect(p!.seq).toBe(0);
    const [{ n }] = (await t.adminDb.execute(sql`select count(*)::int as n from pg_policies where tablename in ('documents','document_revisions','document_templates','attachments')`)) as unknown as [{ n: number }];
    expect(n).toBe(4);
  });
});
