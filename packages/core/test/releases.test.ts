import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { domainEvents, requirementAssignments } from '../src/db/schema';
import { withOrg } from '../src/db/tx';
import { addFieldOption, forkFieldForProduct, listFields } from '../src/definitions/fields';
import type { Actor } from '../src/domain-types';
import { createIteration } from '../src/iterations/iterations';
import {
  createRelease,
  linkRequirementRelease,
  linkRequirementsToRelease,
  listReleases,
  markReleaseReleased,
  unlinkRequirementRelease,
  updateRelease,
} from '../src/releases/releases';
import { getRequirementByKey } from '../src/requirements/detail';
import { createRequirement } from '../src/requirements/requirements';
import { createPlaceholderMember } from '../src/tenancy/members';
import { createProduct, setProductRole } from '../src/tenancy/products';
import { createTestDb } from './db';
import { seedInstance } from './factories';

let t: Awaited<ReturnType<typeof createTestDb>>;
let owner: Actor;
let editor: Actor;
let viewer: Actor;
let readToken: Actor;
let pan: string;
let doc: string;
let platformFieldId: string;
let pc: string;
let priorityP0: string;
let panIteration: string;
let docIteration: string;
let special: string;

beforeAll(async () => {
  t = await createTestDb();
  ({ owner } = await seedInstance(t.db));
  pan = (await createProduct(t.db, owner, { name: '网盘', key: 'PAN' })).id;
  doc = (await createProduct(t.db, owner, { name: '文档', key: 'DOC' })).id;
  const e = await createPlaceholderMember(t.db, owner, { displayName: '开发乙' });
  editor = { ...owner, memberId: e.id, orgRole: 'member', accountId: null };
  const v = await createPlaceholderMember(t.db, owner, { displayName: '只读丙' });
  await setProductRole(t.db, owner, pan, v.id, 'viewer');
  viewer = { ...owner, memberId: v.id, orgRole: 'member', accountId: null };
  readToken = { ...owner, tokenId: '00000000-0000-0000-0000-0000000000f1', tokenScope: { products: 'all', access: 'read' } };
  const fields = await listFields(t.db, owner);
  platformFieldId = fields.find((f) => f.key === 'platform')!.id;
  pc = (await addFieldOption(t.db, owner, platformFieldId, { label: 'PC客户端', key: 'pc' })).id;
  priorityP0 = fields.find((f) => f.key === 'priority')!.options.find((o) => o.key === 'p0')!.id;
  panIteration = (await createIteration(t.db, owner, { type: 'regular', productId: pan, name: '迭代0801', startDate: '2026-08-01', endDate: '2026-08-14' })).id;
  docIteration = (await createIteration(t.db, owner, { type: 'regular', productId: doc, name: '文档迭代', startDate: '2026-08-01', endDate: '2026-08-14' })).id;
  special = (await createIteration(t.db, owner, { type: 'special', name: '专业空间优化', startDate: '2026-08-01', endDate: '2026-09-30' })).id;
});
afterAll(() => t.cleanup());

describe('发布版本', () => {
  let releaseId: string;

  it('编辑可以新建：基线日期等于计划日期；平台与迭代正确回显', async () => {
    const rel = await createRelease(t.db, editor, { productId: pan, versionName: ' 3.2.0 ', platformOptionId: pc, iterationId: panIteration, plannedDate: '2026-08-14', notes: '分享与回收站' });
    releaseId = rel.id;
    expect(rel).toMatchObject({
      productKey: 'PAN',
      versionName: '3.2.0',
      platform: { id: pc, label: 'PC客户端' },
      iteration: { id: panIteration, name: '迭代0801' },
      status: 'planned',
      plannedDate: '2026-08-14',
      baselineDate: '2026-08-14',
      releasedAt: null,
      requirementCount: 0,
      canEdit: true,
    });
  });

  it('只读成员与只读 Token 不能新建或修改', async () => {
    const input = { productId: pan, versionName: '越权', plannedDate: '2026-08-20' };
    await expect(createRelease(t.db, viewer, input)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(createRelease(t.db, readToken, input)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(updateRelease(t.db, viewer, releaseId, { versionName: '越权' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(markReleaseReleased(t.db, readToken, releaseId)).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('平台选项必须属于本产品的「平台」字段；迭代必须同产品或为专项；计划日期必填且合法', async () => {
    await expect(createRelease(t.db, owner, { productId: pan, versionName: 'x', platformOptionId: priorityP0, plannedDate: '2026-08-20' })).rejects.toMatchObject({
      code: 'invalid',
    });
    await expect(createRelease(t.db, owner, { productId: pan, versionName: 'x', iterationId: docIteration, plannedDate: '2026-08-20' })).rejects.toMatchObject({
      code: 'invalid',
      message: '不能关联其他产品的迭代',
    });
    await expect(createRelease(t.db, owner, { productId: pan, versionName: 'x', plannedDate: '2026-13-01' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(createRelease(t.db, owner, { productId: pan, versionName: '  ', plannedDate: '2026-08-20' })).rejects.toMatchObject({ code: 'invalid' });
    const sp = await createRelease(t.db, owner, { productId: doc, versionName: 'D-1.0', iterationId: special, plannedDate: '2026-09-01' });
    expect(sp.iteration).toEqual({ id: special, name: '专业空间优化' });
  });

  it('修改计划日期不改变基线；记录变更', async () => {
    const rel = await updateRelease(t.db, editor, releaseId, { plannedDate: '2026-08-20', notes: null });
    expect(rel).toMatchObject({ plannedDate: '2026-08-20', baselineDate: '2026-08-14', notes: null });
    const [ev] = await withOrg(t.db, owner.orgId, (tx) =>
      tx.select().from(domainEvents).where(and(eq(domainEvents.subjectId, releaseId), eq(domainEvents.type, 'release.updated'))),
    );
    expect(ev!.payload).toMatchObject({ changes: [{ field: 'plannedDate', old: '2026-08-14', new: '2026-08-20' }, { field: 'notes', old: '分享与回收站', new: null }] });
  });

  it('计划发布日期是必填项：更新时传 null 拒绝', async () => {
    await expect(updateRelease(t.db, editor, releaseId, { plannedDate: null })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('按产品或按迭代列出；关联需求后计数变化；只能关联同产品需求；重复关联与解除不报错', async () => {
    const req = await createRequirement(t.db, owner, pan, { title: '分享链接加密码' });
    const docReq = await createRequirement(t.db, owner, doc, { title: '文档导出' });
    await linkRequirementRelease(t.db, editor, releaseId, req.id);
    await linkRequirementRelease(t.db, editor, releaseId, req.id);
    await expect(linkRequirementRelease(t.db, owner, releaseId, docReq.id)).rejects.toMatchObject({ code: 'invalid', message: '只能关联本产品的需求' });
    await expect(linkRequirementRelease(t.db, viewer, releaseId, req.id)).rejects.toMatchObject({ code: 'forbidden' });
    expect((await listReleases(t.db, viewer, { productId: pan })).map((r) => [r.versionName, r.requirementCount, r.canEdit])).toEqual([['3.2.0', 1, false]]);
    expect((await listReleases(t.db, owner, { iterationId: special })).map((r) => r.versionName)).toEqual(['D-1.0']);
    expect((await getRequirementByKey(t.db, owner, req.displayKey)).releases.map((r) => r.versionName)).toEqual(['3.2.0']);
    const linked = await withOrg(t.db, owner.orgId, (tx) =>
      tx.select().from(domainEvents).where(and(eq(domainEvents.subjectId, req.id), eq(domainEvents.type, 'requirement.release_linked'))),
    );
    expect(linked).toHaveLength(1);
    await unlinkRequirementRelease(t.db, editor, releaseId, req.id);
    await unlinkRequirementRelease(t.db, editor, releaseId, req.id);
    expect((await getRequirementByKey(t.db, owner, req.displayKey)).releases).toEqual([]);
    await expect(listReleases(t.db, owner, {})).rejects.toMatchObject({ code: 'invalid' });
  });

  it('标记发布写入发布时间；已发布的不能再标记', async () => {
    const rel = await markReleaseReleased(t.db, editor, releaseId);
    expect(rel.status).toBe('released');
    expect(rel.releasedAt).toBeInstanceOf(Date);
    await expect(markReleaseReleased(t.db, editor, releaseId)).rejects.toMatchObject({ code: 'invalid', message: '该版本已发布' });
  });

  it('并发标记发布只有一次成功，只写入一条 release.released 事件', async () => {
    const rel = await createRelease(t.db, editor, { productId: doc, versionName: '3.3.0', plannedDate: '2026-09-01' });
    const results = await Promise.allSettled([markReleaseReleased(t.db, editor, rel.id), markReleaseReleased(t.db, editor, rel.id)]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'invalid', message: '该版本已发布' });
    const events = await withOrg(t.db, owner.orgId, (tx) =>
      tx.select().from(domainEvents).where(and(eq(domainEvents.subjectId, rel.id), eq(domainEvents.type, 'release.released'))),
    );
    expect(events).toHaveLength(1);
  });

  it('批量关联：去重、跳过已关联、每条新关联记一条事件；有一条不属于本产品时整批不写入', async () => {
    const a = await createRequirement(t.db, owner, pan, { title: '批量关联一' });
    const b = await createRequirement(t.db, owner, pan, { title: '批量关联二' });
    const other = await createRequirement(t.db, owner, doc, { title: '别的产品' });
    // 计划日期取得早，按计划日期倒序时排在最后，不影响后面按产品取第一条的用例
    const rel = await createRelease(t.db, editor, { productId: pan, versionName: '3.1.9', plannedDate: '2026-01-15' });
    const view = async () => (await listReleases(t.db, owner, { productId: pan })).find((r) => r.id === rel.id)!;

    await expect(linkRequirementsToRelease(t.db, editor, rel.id, [a.id, other.id])).rejects.toMatchObject({ code: 'invalid', message: '只能关联本产品的需求' });
    expect(await view()).toMatchObject({ requirementCount: 0, requirementIds: [] });
    expect(await linkRequirementsToRelease(t.db, editor, rel.id, [a.id, a.id])).toEqual({ linked: 1 });
    expect(await linkRequirementsToRelease(t.db, editor, rel.id, [a.id, b.id])).toEqual({ linked: 1 });
    await expect(linkRequirementsToRelease(t.db, viewer, rel.id, [a.id])).rejects.toMatchObject({ code: 'forbidden' });
    await expect(linkRequirementsToRelease(t.db, readToken, rel.id, [a.id])).rejects.toMatchObject({ code: 'forbidden' });
    await expect(linkRequirementsToRelease(t.db, editor, rel.id, [])).rejects.toMatchObject({ code: 'invalid', message: '一次关联 1–200 条需求' });

    const v = await view();
    expect(v.requirementCount).toBe(2);
    expect([...v.requirementIds].sort()).toEqual([a.id, b.id].sort());
    const events = await withOrg(t.db, owner.orgId, (tx) =>
      tx.select().from(domainEvents).where(and(eq(domainEvents.type, 'requirement.release_linked'), inArray(domainEvents.subjectId, [a.id, b.id]))),
    );
    expect(events).toHaveLength(2);
  });

  it('并发且有重叠的两批关联都成功，或失败是中文 AppError，不是 500；每条链接只记一条事件', async () => {
    const a = await createRequirement(t.db, owner, pan, { title: '并发关联一' });
    const b = await createRequirement(t.db, owner, pan, { title: '并发关联二' });
    const rel = await createRelease(t.db, editor, { productId: pan, versionName: '3.1.10', plannedDate: '2026-01-16' });

    const results = await Promise.allSettled([
      linkRequirementsToRelease(t.db, editor, rel.id, [a.id, b.id]),
      linkRequirementsToRelease(t.db, editor, rel.id, [b.id, a.id]),
    ]);
    for (const r of results) {
      if (r.status === 'rejected') expect(r.reason).toMatchObject({ code: expect.any(String), message: expect.stringMatching(/[一-龥]/) });
    }

    const v = (await listReleases(t.db, owner, { productId: pan })).find((r) => r.id === rel.id)!;
    expect(v.requirementCount).toBe(2);
    expect([...v.requirementIds].sort()).toEqual([a.id, b.id].sort());
    const events = await withOrg(t.db, owner.orgId, (tx) =>
      tx.select().from(domainEvents).where(and(eq(domainEvents.type, 'requirement.release_linked'), inArray(domainEvents.subjectId, [a.id, b.id]))),
    );
    expect(events).toHaveLength(2);
  });
});

describe('平台字段按产品覆盖', () => {
  it('本产品发布版本与开发分配上的平台选项改指向产品级选项，计入 movedValues；其他产品不受影响', async () => {
    const pid = (await createProduct(t.db, owner, { name: '相册', key: 'PIC' })).id;
    const req = await createRequirement(t.db, owner, pid, { title: '相册备份', fields: { platform: [pc] } });
    await createRelease(t.db, owner, { productId: pid, versionName: '2.0.0', platformOptionId: pc, plannedDate: '2026-10-01' });
    await withOrg(t.db, owner.orgId, (tx) =>
      tx.insert(requirementAssignments).values({ orgId: owner.orgId, requirementId: req.id, memberId: owner.memberId, platformOptionId: pc }),
    );
    const forked = await forkFieldForProduct(t.db, owner, pid, platformFieldId);
    const newPc = forked.options.find((o) => o.key === 'pc')!.id;

    const [picRelease] = await listReleases(t.db, owner, { productId: pid });
    expect(picRelease!.platform).toMatchObject({ id: newPc, label: 'PC客户端' });
    const assignments = await withOrg(t.db, owner.orgId, (tx) =>
      tx.select({ platformOptionId: requirementAssignments.platformOptionId }).from(requirementAssignments).where(eq(requirementAssignments.requirementId, req.id)),
    );
    expect(assignments).toEqual([{ platformOptionId: newPc }]);
    const [panRelease] = await listReleases(t.db, owner, { productId: pan });
    expect(panRelease!.platform!.id).toBe(pc);
    const [ev] = await withOrg(t.db, owner.orgId, (tx) =>
      tx.select().from(domainEvents).where(and(eq(domainEvents.subjectId, forked.id), eq(domainEvents.type, 'field.forked'))),
    );
    expect(ev!.payload).toMatchObject({ movedValues: 3 });
  });
});
