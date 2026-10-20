import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { documents, requirements } from '../src/db/schema';
import type { Actor } from '../src/domain-types';
import { createBrief } from '../src/documents/briefs';
import { unlinkDocumentRequirement } from '../src/documents/coverage';
import { createDocument, transitionDocument } from '../src/documents/documents';
import { assembleChangeDocuments, type ChangeDocumentEvent, type ChangeDocumentRow } from '../src/requirements/change-documents';
import { getRequirementByKey } from '../src/requirements/detail';
import { createRequirement } from '../src/requirements/requirements';
import { createWorkflowTemplate, setProductWorkflowVersion } from '../src/definitions/workflows';
import { listFunctionTags } from '../src/tenancy/function-tags';
import { createProduct } from '../src/tenancy/products';
import { createTestDb } from './db';
import { prdWorkflow, seedInstance } from './factories';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const t1 = new Date('2026-10-01T00:00:00.000Z');
const t2 = new Date('2026-10-02T00:00:00.000Z');
const t3 = new Date('2026-10-03T00:00:00.000Z');

function row(id: string, title: string): ChangeDocumentRow {
  return { id, displayKey: `PAN-PRD-${id.slice(0, 1).toUpperCase()}`, title, status: 'draft', source: 'external' };
}

function mounted(id: string | null, at: Date, old: string | null = null): ChangeDocumentEvent {
  return { occurredAt: at, payload: { schemaVersion: 1, changes: [{ field: 'changeDocumentId', old, new: id }] } };
}

describe('assembleChangeDocuments', () => {
  it('从未挂过：空列表', () => {
    expect(assembleChangeDocuments({ changeDocumentId: null, events: [], documents: [] })).toEqual([]);
  });

  it('只挂一份：当前项带上挂载时间', () => {
    const docs = [row(A, '甲')];
    expect(assembleChangeDocuments({ changeDocumentId: A, events: [mounted(A, t1)], documents: docs })).toEqual([
      { ...docs[0], current: true, linkedAt: t1 },
    ]);
  });

  it('挂 A、卸 A、再挂 B：当前置顶，其余按最近一次挂上的时间从新到旧', () => {
    const docs = [row(A, '甲'), row(B, '乙')];
    const events = [mounted(A, t1), mounted(null, t2, A), mounted(B, t3)];
    expect(assembleChangeDocuments({ changeDocumentId: B, events, documents: docs })).toEqual([
      { ...docs[1], current: true, linkedAt: t3 },
      { ...docs[0], current: false, linkedAt: t1 },
    ]);
  });

  it('仅有当前外键、没有 changeDocumentId 事件：只列出当前，不补时间，也不编造更早的文档', () => {
    const docs = [row(A, '甲')];
    const items = assembleChangeDocuments({ changeDocumentId: A, events: [], documents: docs });
    expect(items).toEqual([{ ...docs[0], current: true }]);
    expect(items[0]).not.toHaveProperty('linkedAt');
    expect(items).toHaveLength(1);
  });

  it('事件里的 id 查不到（已删除或未返回）时略去，不抛错', () => {
    const docs = [row(B, '乙')];
    expect(assembleChangeDocuments({ changeDocumentId: B, events: [mounted(A, t1), mounted(null, t2, A), mounted(B, t3)], documents: docs })).toEqual([
      { ...docs[0], current: true, linkedAt: t3 },
    ]);
  });

  it('简报字段和标题修改不算变更 PRD；同一文档再次挂上时用更晚的时间', () => {
    const docs = [row(A, '甲'), row(B, '乙')];
    const events: ChangeDocumentEvent[] = [
      mounted(B, t3),
      { occurredAt: t2, payload: { changes: [{ field: 'briefDocumentId', old: null, new: A }, { field: 'title', old: '旧', new: '新' }] } },
      mounted(A, t1),
      mounted(A, t3),
    ];
    const items = assembleChangeDocuments({ changeDocumentId: A, events, documents: docs });
    expect(items.map((item) => [item.id, item.current, item.linkedAt?.toISOString()])).toEqual([
      [A, true, t3.toISOString()],
      [B, false, t3.toISOString()],
    ]);
  });

  it('全部卸下后仍保留历史，没有当前项', () => {
    const docs = [row(A, '甲'), row(B, '乙')];
    const items = assembleChangeDocuments({
      changeDocumentId: null,
      events: [mounted(A, t1), mounted(null, t2, A), mounted(B, t3), mounted(null, t3, B)],
      documents: docs,
    });
    expect(items.map((item) => [item.id, item.current])).toEqual([
      [B, false],
      [A, false],
    ]);
  });
});

describe('需求详情 changeDocuments', () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let owner: Actor;
  let pan: string;

  beforeAll(async () => {
    t = await createTestDb();
    ({ owner } = await seedInstance(t.db));
    pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
    const designTag = (await listFunctionTags(t.db, owner)).find((x) => x.name === '设计')!.id;
    const { version } = await createWorkflowTemplate(t.db, owner, { name: 'PRD 流程', body: prdWorkflow(designTag) });
    await setProductWorkflowVersion(t.db, owner, pan, version.id);
  });
  afterAll(() => t?.cleanup());

  function expectCurrentMatches(detail: Awaited<ReturnType<typeof getRequirementByKey>>) {
    const current = detail.changeDocuments.filter((item) => item.current);
    if (!detail.changeDocument) {
      expect(current).toEqual([]);
      return;
    }
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject(detail.changeDocument);
  }

  it('从未挂过：changeDocuments 为空', async () => {
    const req = await createRequirement(t.db, owner, pan, { title: '还没挂' });
    const detail = await getRequirementByKey(t.db, owner, req.displayKey);
    expect(detail.changeDocument).toBeNull();
    expect(detail.changeDocuments).toEqual([]);
  });

  it('只挂一份：数组只有当前，且与 changeDocument 一致', async () => {
    const req = await createRequirement(t.db, owner, pan, { title: '只挂一份' });
    const doc = await createDocument(t.db, owner, pan, { title: '唯一 PRD', externalUrl: 'https://doc.weixin.qq.com/doc/only', requirementIds: [req.id] });
    const detail = await getRequirementByKey(t.db, owner, req.displayKey);
    expect(detail.changeDocument).toEqual({ id: doc.id, displayKey: doc.displayKey, title: '唯一 PRD', status: 'draft', source: 'external' });
    expect(detail.changeDocuments).toHaveLength(1);
    expect(detail.changeDocuments[0]).toMatchObject({ ...detail.changeDocument, current: true });
    expect(detail.changeDocuments[0]!.linkedAt).toBeInstanceOf(Date);
    expectCurrentMatches(detail);
  });

  it('挂 A、卸 A、再挂 B：两份都在，B 为当前并置顶；卸下后检查项跟随后来挂上的 B', async () => {
    const req = await createRequirement(t.db, owner, pan, { title: '换过 PRD' });
    const a = await createDocument(t.db, owner, pan, { title: 'PRD 甲', externalUrl: 'https://doc.weixin.qq.com/doc/a-hist', requirementIds: [req.id] });
    await transitionDocument(t.db, owner, a.id, { to: 'review' });
    await transitionDocument(t.db, owner, a.id, { to: 'approved' });
    await unlinkDocumentRequirement(t.db, owner, a.id, req.id);
    const detached = await getRequirementByKey(t.db, owner, req.displayKey);
    expect(detached.changeDocument).toBeNull();
    expect(detached.changeDocuments.map((item) => [item.displayKey, item.current])).toEqual([[a.displayKey, false]]);

    const b = await createDocument(t.db, owner, pan, { title: 'PRD 乙', externalUrl: 'https://doc.weixin.qq.com/doc/b-hist', requirementIds: [req.id] });
    const detail = await getRequirementByKey(t.db, owner, req.displayKey);
    expect(detail.changeDocuments.map((item) => [item.id, item.current])).toEqual([
      [b.id, true],
      [a.id, false],
    ]);
    expect(detail.changeDocuments[0]!.linkedAt!.getTime()).toBeGreaterThanOrEqual(detail.changeDocuments[1]!.linkedAt!.getTime());
    expectCurrentMatches(detail);
    expect(detail.checkItems.find((item) => item.key === 'prd')).toMatchObject({ state: 'in_progress', locked: true });
    expect(detail.documentCheckItems.map((item) => item.key)).toEqual(['prd_review']);

    await t.adminDb.update(documents).set({ deletedAt: new Date() }).where(eq(documents.id, a.id));
    const afterDelete = await getRequirementByKey(t.db, owner, req.displayKey);
    expect(afterDelete.changeDocuments.map((item) => item.id)).toEqual([b.id]);
    expectCurrentMatches(afterDelete);
  });

  it('仅有当前外键、没有 changeDocumentId 事件：历史不全时不谎称完整', async () => {
    const req = await createRequirement(t.db, owner, pan, { title: '只有外键' });
    const doc = await createDocument(t.db, owner, pan, { title: '直接写上的 PRD', externalUrl: 'https://doc.weixin.qq.com/doc/fk-only' });
    await t.adminDb.update(requirements).set({ changeDocumentId: doc.id }).where(eq(requirements.id, req.id));
    const detail = await getRequirementByKey(t.db, owner, req.displayKey);
    expect(detail.changeDocuments).toEqual([{ id: doc.id, displayKey: doc.displayKey, title: '直接写上的 PRD', status: 'draft', source: 'external', current: true }]);
    expect(detail.changeDocuments[0]).not.toHaveProperty('linkedAt');
    expectCurrentMatches(detail);
  });

  it('简报挂载不进入 changeDocuments', async () => {
    const req = await createRequirement(t.db, owner, pan, { title: '有简报' });
    const brief = await createBrief(t.db, owner, pan, { title: '一份简报', requirementIds: [req.id] });
    const detail = await getRequirementByKey(t.db, owner, req.displayKey);
    expect(detail.brief?.id).toBe(brief.id);
    expect(detail.changeDocument).toBeNull();
    expect(detail.changeDocuments).toEqual([]);
  });
});
