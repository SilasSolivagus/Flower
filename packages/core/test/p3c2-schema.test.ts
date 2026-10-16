import { readFileSync } from 'node:fs';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { documentBriefs, documents, documentTemplates, organizations, products, requirements } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import { BRIEF_TEMPLATE } from '../src/documents/brief-template';
import type { Actor } from '../src/domain-types';
import { newId } from '../src/ids';
import { createRequirement } from '../src/requirements/requirements';
import { createProduct } from '../src/tenancy/products';
import { createTestDb } from './db';
import { seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let productId: string;
const orgB = newId();

/** 迁移 0022 除前两段（开启 RLS、建策略）以外的语句：补齐预置简报模板。 */
const BACKFILL = readFileSync(new URL('../migrations/0022_p3c2_briefs.sql', import.meta.url), 'utf8')
  .split('--> statement-breakpoint')
  .map((s) => s.trim())
  .filter(Boolean)
  .slice(2);
const runBackfill = async () => {
  for (const s of BACKFILL) await t.adminDb.execute(sql.raw(s));
};
const doc = (number: number, kind: 'change' | 'brief', title: string) => ({
  orgId: owner.orgId,
  productId,
  number,
  kind,
  source: 'native' as const,
  title,
  status: kind === 'brief' ? ('discussing' as const) : ('draft' as const),
});

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  await t.adminDb.insert(organizations).values({ id: orgB, slug: 'b', name: 'B' });
  productId = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
});
afterAll(() => t.cleanup());

describe('P3-C2 数据模型', () => {
  it('document_briefs 受行级安全约束，有一条策略；与文档一对一', async () => {
    const [brief] = await t.adminDb.insert(documents).values(doc(1, 'brief', '简报一')).returning();
    await withOrg(t.db, owner.orgId, (tx) => tx.insert(documentBriefs).values({ documentId: brief!.id, orgId: owner.orgId }));
    expect(await withOrg(t.db, owner.orgId, (tx) => tx.select().from(documentBriefs))).toHaveLength(1);
    expect(await withOrg(t.db, orgB, (tx) => tx.select().from(documentBriefs))).toHaveLength(0);
    await expect(t.adminDb.insert(documentBriefs).values({ documentId: brief!.id, orgId: owner.orgId })).rejects.toThrow();
    const [{ n }] = (await t.adminDb.execute(sql`select count(*)::int as n from pg_policies where tablename = 'document_briefs'`)) as unknown as [{ n: number }];
    expect(n).toBe(1);
  });

  it('默认值；简报与 PRD 各自编号，同一产品里可以都有 1 号，同类不能重号', async () => {
    const [b] = await t.adminDb.select().from(documentBriefs);
    expect(b).toMatchObject({
      version: 'v0.1',
      requesterMemberId: null,
      deciderMemberId: null,
      authorMemberId: null,
      participantTagIds: [],
      relatedLinks: [],
      gateChecks: [],
      convertedDocumentId: null,
    });
    const [p] = await t.adminDb.select().from(products).where(eq(products.id, productId));
    expect(p!.briefSeq).toBe(0);
    await t.adminDb.insert(documents).values(doc(1, 'change', 'PRD 一'));
    await expect(t.adminDb.insert(documents).values(doc(1, 'brief', '重号简报'))).rejects.toThrow();
    await expect(t.adminDb.insert(documents).values(doc(1, 'change', '重号 PRD'))).rejects.toThrow();
  });

  it('需求可以同时挂一份简报和一份 PRD；模板说明默认为空', async () => {
    const r = await createRequirement(t.db, owner, productId, { title: '挂简报' });
    const [brief] = await t.adminDb.select().from(documents).where(eq(documents.kind, 'brief'));
    const [prd] = await t.adminDb.select().from(documents).where(eq(documents.kind, 'change'));
    await t.adminDb.update(requirements).set({ briefDocumentId: brief!.id, changeDocumentId: prd!.id }).where(eq(requirements.id, r.id));
    const [row] = await t.adminDb.select().from(requirements).where(eq(requirements.id, r.id));
    expect([row!.briefDocumentId, row!.changeDocumentId]).toEqual([brief!.id, prd!.id]);
    const [tpl] = await t.adminDb
      .select()
      .from(documentTemplates)
      .where(and(eq(documentTemplates.orgId, owner.orgId), eq(documentTemplates.kind, 'change')));
    expect(tpl!.guidance).toBe('');
  });
});

describe('迁移 0022 的补齐', () => {
  it('为没有组织级简报模板的组织写入预置简报模板，内容与代码里的常量逐字一致；可重复执行', async () => {
    await t.adminDb.delete(documentTemplates).where(eq(documentTemplates.kind, 'brief'));
    await runBackfill();
    await runBackfill();
    for (const org of [owner.orgId, orgB]) {
      const rows = await t.adminDb
        .select()
        .from(documentTemplates)
        .where(and(eq(documentTemplates.orgId, org), eq(documentTemplates.kind, 'brief')));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ productId: null, name: BRIEF_TEMPLATE.name, active: true });
      expect(rows[0]!.body).toBe(BRIEF_TEMPLATE.body);
      expect(rows[0]!.guidance).toBe(BRIEF_TEMPLATE.guidance);
      expect(rows[0]!.sections).toEqual(BRIEF_TEMPLATE.sections);
    }
  });
});
