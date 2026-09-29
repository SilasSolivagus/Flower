import {
  addRequirementComment,
  apiTokens,
  comments,
  createRequirement,
  fieldDefinitions,
  iterations,
  iterationScopeSnapshots,
  forkFieldForProduct,
  forkWorkflowForProduct,
  getRequirementByKey,
  issueToken,
  listFields,
  listProducts,
  listRequirements,
  resolveActor,
  tasks,
  workflowDefinitions,
} from '@flower/core';
import { createTestDb } from '@flower/core/testing';
import { seedInstance } from '@flower/core/testing/factories';
import { eq, isNotNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildImportPlan } from '../src/plan';
import type { ImportOptions } from '../src/plan-types';
import { writeImport } from '../src/write';
import { makeLegacyData, reviewedMapping } from './fixtures';

let t: Awaited<ReturnType<typeof createTestDb>>;
let opts: ImportOptions;
beforeAll(async () => {
  t = await createTestDb();
  const { account } = await seedInstance(t.db);
  opts = { orgSlug: 'pan123', orgName: '123云盘', productKey: 'PAN', productName: '123云盘', asOf: '2026-09-29', owner: { accountId: account.id, email: account.email, name: account.name } };
});
afterAll(() => t.cleanup());

describe('写入数据库', () => {
  it('导入后可以用正常的服务函数读写', async () => {
    await writeImport(t.adminDb, buildImportPlan(makeLegacyData(), reviewedMapping(), opts), { replace: false });
    const actor = (await resolveActor(t.db, opts.owner!.accountId, 'pan123'))!;
    expect(actor.orgRole).toBe('owner');
    const [product] = await listProducts(t.db, actor);
    const list = await listRequirements(t.db, actor, product!.id, { sort: 'number' });
    expect(list.total).toBe(5);
    expect(list.items[4]).toMatchObject({ displayKey: 'PAN-1', title: '批量下载', stateKey: 'developing', iteration: { name: 'it0316' } });
    const d = await getRequirementByKey(t.db, actor, 'X001');
    expect(d.displayKey).toBe('PAN-1');
    expect(d.checkItems.find((c) => c.key === 'design_signoff')).toMatchObject({ state: 'in_progress', signoffs: expect.arrayContaining([expect.objectContaining({ ruleIndex: 3, signer: expect.objectContaining({ displayName: '王老板' }) })]) });
    expect(d.transitions.find((x) => x.to === 'to_design')).toMatchObject({ allowed: true });
    const created = await createRequirement(t.db, actor, product!.id, { title: '迁移后新建的需求' });
    expect(created.number).toBe(6);
  });

  it('组织已存在时必须加 replace；覆盖后回到导入时的数据', async () => {
    const plan = buildImportPlan(makeLegacyData(), reviewedMapping(), opts);
    await expect(writeImport(t.adminDb, plan, { replace: false })).rejects.toThrow('已存在');
    await writeImport(t.adminDb, plan, { replace: true });
    const actor = (await resolveActor(t.db, opts.owner!.accountId, 'pan123'))!;
    const [product] = await listProducts(t.db, actor);
    expect((await listRequirements(t.db, actor, product!.id)).total).toBe(5);
  });

  it('导入后有过正常使用（复制流程/字段、签发 Token、新建需求与评论）仍可以 replace', async () => {
    const plan = buildImportPlan(makeLegacyData(), reviewedMapping(), opts);
    const actor = (await resolveActor(t.db, opts.owner!.accountId, 'pan123'))!;
    const [product] = await listProducts(t.db, actor);
    const importedVersionId = product!.workflowVersionId!;
    await forkWorkflowForProduct(t.db, actor, product!.id, { fromVersionId: importedVersionId });
    const orgField = (await listFields(t.db, actor)).find((f) => f.key === 'priority' && f.productId === null)!;
    await forkFieldForProduct(t.db, actor, product!.id, orgField.id);
    await issueToken(t.db, actor, { memberId: actor.memberId, name: '脚本', scope: { products: 'all', access: 'write' } });
    const created = await createRequirement(t.db, actor, product!.id, { title: '导入后新建' });
    await addRequirementComment(t.db, actor, created.id, { body: '导入后的评论' });
    const [iteration] = await t.adminDb.select({ id: iterations.id }).from(iterations).where(eq(iterations.orgId, actor.orgId));
    await t.adminDb.insert(iterationScopeSnapshots).values({ orgId: actor.orgId, iterationId: iteration!.id, requirementId: created.id, snapshotKind: 'committed' });

    await writeImport(t.adminDb, plan, { replace: true });

    const after = (await resolveActor(t.db, opts.owner!.accountId, 'pan123'))!;
    const [p] = await listProducts(t.db, after);
    expect(p!.workflowVersionId).toBe(importedVersionId);
    expect((await listRequirements(t.db, after, p!.id)).total).toBe(5);
    expect(await t.adminDb.select().from(workflowDefinitions).where(isNotNull(workflowDefinitions.productId))).toEqual([]);
    expect(await t.adminDb.select().from(fieldDefinitions).where(isNotNull(fieldDefinitions.productId))).toEqual([]);
    expect(await t.adminDb.select().from(apiTokens)).toEqual([]);
    expect(await t.adminDb.select().from(iterationScopeSnapshots)).toEqual([]);
    expect(await t.adminDb.select().from(comments).where(eq(comments.body, '导入后的评论'))).toEqual([]);
  });

  it('计划中有问题时拒绝写入', async () => {
    const data = makeLegacyData();
    data.plane.requirements[0]!.requester = '新面孔';
    await expect(writeImport(t.adminDb, buildImportPlan(data, reviewedMapping(), { ...opts, orgSlug: 'other' }), { replace: false })).rejects.toThrow('拒绝写入');
  });

  it('甘特任务的半天计划/延期天数写入数据库后原样保留', async () => {
    const data = makeLegacyData();
    data.push.ganttTasks.push({
      id: 4, requirement_id: 1, version_id: null, title: '半天任务', assignee: null, phase: null, plan_start: '2026-03-02',
      plan_days: 0.5, delay_days: 1.5, actual_status: '', note: '', flag: '', created_at: null, alias: null,
      starred: null, ov_assignee: null, ov_status: null, ov_progress: null, manual: null,
    });
    await writeImport(t.adminDb, buildImportPlan(data, reviewedMapping(), opts), { replace: true });
    const [row] = await t.adminDb.select({ planDays: tasks.planDays, delayDays: tasks.delayDays }).from(tasks).where(eq(tasks.title, '半天任务'));
    expect(row).toMatchObject({ planDays: 0.5, delayDays: 1.5 });
  });
});
