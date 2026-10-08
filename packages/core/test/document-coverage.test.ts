import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkItemResults, domainEvents } from '../src/db/schema';
import { createWorkflowTemplate, setProductWorkflowVersion } from '../src/definitions/workflows';
import type { Actor } from '../src/domain-types';
import { linkDocumentRequirements, unlinkDocumentRequirement } from '../src/documents/coverage';
import { createDocument, getDocumentByKey, transitionDocument } from '../src/documents/documents';
import { createRequirement } from '../src/requirements/requirements';
import { setCheckItemState } from '../src/requirements/transitions';
import { listReviewQueue } from '../src/reviews/queue';
import { listFunctionTags } from '../src/tenancy/function-tags';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createTestDb } from './db';
import { asMember, prdWorkflow, readOnlyToken, seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let viewer: Actor;
let pan: string;
let other: string;

async function prdState(requirementId: string): Promise<string | undefined> {
  const [r] = await t.adminDb
    .select({ state: checkItemResults.state })
    .from(checkItemResults)
    .where(and(eq(checkItemResults.targetType, 'requirement'), eq(checkItemResults.targetId, requirementId), eq(checkItemResults.itemKey, 'prd')));
  return r?.state;
}

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  other = (await createProduct(t.db, owner, { name: '相册', key: 'PIC' })).id;
  const designTag = (await listFunctionTags(t.db, owner)).find((x) => x.name === '设计')!.id;
  const { version } = await createWorkflowTemplate(t.db, owner, { name: 'PRD 流程', body: prdWorkflow(designTag) });
  await setProductWorkflowVersion(t.db, owner, pan, version.id);
  viewer = await asMember(t.db, owner, '只读乙');
  await setProductRole(t.db, owner, pan, viewer.memberId, 'viewer');
});
afterAll(() => t.cleanup());

describe('覆盖需求与「PRD」检查项', () => {
  it('新建时挂上需求：「PRD」项变为进行中；PRD 状态变化时同步；被覆盖的需求不能手改「PRD」项', async () => {
    const r1 = await createRequirement(t.db, owner, pan, { title: '分片上传' });
    const r2 = await createRequirement(t.db, owner, pan, { title: '断点续传' });
    await setCheckItemState(t.db, owner, r2.id, 'prd', { state: 'passed' });
    const d = await createDocument(t.db, owner, pan, { title: '上传 PRD', externalUrl: 'https://doc.weixin.qq.com/doc/up', requirementIds: [r1.id, r2.id] });
    expect(d.requirements.map((r) => r.displayKey)).toEqual(['PAN-1', 'PAN-2']);
    expect([await prdState(r1.id), await prdState(r2.id)]).toEqual(['in_progress', 'in_progress']);
    await expect(setCheckItemState(t.db, owner, r1.id, 'prd', { state: 'passed' })).rejects.toMatchObject({
      code: 'invalid',
      message: '「PRD」检查项跟随所挂 PRD 的状态，不能手动修改',
    });
    await transitionDocument(t.db, owner, d.id, { to: 'review' });
    await transitionDocument(t.db, owner, d.id, { to: 'approved' });
    expect(await prdState(r1.id)).toBe('passed');
    await transitionDocument(t.db, owner, d.id, { to: 'discarded' });
    expect(await prdState(r2.id)).toBe('not_needed');
    const events = await t.adminDb.select().from(domainEvents).where(and(eq(domainEvents.subjectId, r1.id), eq(domainEvents.type, 'check_item.updated')));
    expect(events.map((e) => (e.payload as { changes: Array<{ new: string }> }).changes[0]!.new)).toEqual(['in_progress', 'passed', 'not_needed']);
    expect(events.every((e) => (e.payload as { auto?: boolean; documentId?: string }).auto === true && (e.payload as { documentId?: string }).documentId === d.id)).toBe(true);
  });

  it('一条需求只能挂一份 PRD；不能挂其他产品的需求；移出后恢复手工维护并保留当时的值', async () => {
    const r = await createRequirement(t.db, owner, pan, { title: '秒传' });
    const a = await createDocument(t.db, owner, pan, { title: 'A', externalUrl: 'https://doc.weixin.qq.com/doc/a' });
    const b = await createDocument(t.db, owner, pan, { title: 'B', externalUrl: 'https://doc.weixin.qq.com/doc/b' });
    expect(await linkDocumentRequirements(t.db, owner, a.id, { requirementIds: [r.id, r.id] })).toEqual({ linked: 1 });
    const [linkedEvent] = await t.adminDb.select().from(domainEvents).where(and(eq(domainEvents.subjectId, a.id), eq(domainEvents.type, 'document.requirements_linked')));
    expect(linkedEvent!.payload).toMatchObject({ changes: [{ field: 'requirements', old: null, new: [r.displayKey] }] });
    expect(await linkDocumentRequirements(t.db, owner, a.id, { requirementIds: [r.id] })).toEqual({ linked: 0 });
    await expect(linkDocumentRequirements(t.db, owner, b.id, { requirementIds: [r.id] })).rejects.toMatchObject({
      code: 'conflict',
      message: `${r.displayKey} 已挂在 ${a.displayKey} 上，请先从那份 PRD 移出`,
    });
    const elsewhere = await createRequirement(t.db, owner, other, { title: '别的产品' });
    await expect(linkDocumentRequirements(t.db, owner, b.id, { requirementIds: [elsewhere.id] })).rejects.toMatchObject({ message: 'PIC-1 不属于这份 PRD 所在的产品' });
    await unlinkDocumentRequirement(t.db, owner, a.id, r.id);
    const [unlinkedEvent] = await t.adminDb.select().from(domainEvents).where(and(eq(domainEvents.subjectId, a.id), eq(domainEvents.type, 'document.requirement_unlinked')));
    expect(unlinkedEvent!.payload).toMatchObject({ changes: [{ field: 'requirements', old: r.displayKey, new: null }] });
    expect(await prdState(r.id)).toBe('in_progress');
    await setCheckItemState(t.db, owner, r.id, 'prd', { state: 'not_needed' });
    expect((await getDocumentByKey(t.db, owner, a.displayKey)).requirementCount).toBe(0);
    await expect(unlinkDocumentRequirement(t.db, owner, a.id, r.id)).rejects.toMatchObject({ message: '该需求没有挂在这份 PRD 上' });
  });

  it('权限：只读成员与只读 Token 不能改覆盖；已废弃的 PRD 不能再挂需求', async () => {
    const r = await createRequirement(t.db, owner, pan, { title: '权限' });
    const d = await createDocument(t.db, owner, pan, { title: 'C', externalUrl: 'https://doc.weixin.qq.com/doc/c' });
    await expect(linkDocumentRequirements(t.db, viewer, d.id, { requirementIds: [r.id] })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(linkDocumentRequirements(t.db, readOnlyToken(owner), d.id, { requirementIds: [r.id] })).rejects.toMatchObject({ code: 'forbidden' });
    await transitionDocument(t.db, owner, d.id, { to: 'discarded' });
    await expect(linkDocumentRequirements(t.db, owner, d.id, { requirementIds: [r.id] })).rejects.toMatchObject({ message: '已废弃的 PRD 不能再关联需求' });
  });

  it('评审队列：auto 的「PRD」项不计入整体评审状态，但仍显示在列与单元格里', async () => {
    const r = await createRequirement(t.db, owner, pan, { title: '评审队列联动' });
    await setCheckItemState(t.db, owner, r.id, 'feasibility', { state: 'passed' });
    await createDocument(t.db, owner, pan, { title: 'D', externalUrl: 'https://doc.weixin.qq.com/doc/d', requirementIds: [r.id] });
    const q = await listReviewQueue(t.db, owner, pan, { state: 'all' });
    const row = q.rows.find((x) => x.displayKey === r.displayKey)!;
    expect(row.cells.prd).toMatchObject({ state: 'in_progress' });
    expect(row.reviewState).toBe('passed');
  });
});
