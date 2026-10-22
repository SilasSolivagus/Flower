import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  addDocumentComment,
  addRequirementComment,
  attachments,
  apiTokens,
  blockers,
  comments,
  createDocument,
  createLocalStorage,
  createRequirement,
  createStructureNode,
  documentAffectedNodes,
  documentBriefs,
  documentRevisions,
  documents,
  domainEvents,
  entityLinks,
  fieldDefinitions,
  iterations,
  iterationScopeSnapshots,
  forkFieldForProduct,
  forkWorkflowForProduct,
  getDocumentByKey,
  getRequirementByKey,
  issueToken,
  listDocumentComments,
  listChannels,
  listFields,
  listProducts,
  listRequirements,
  listSchedules,
  memberNotifications,
  messageTemplates,
  notificationChannels,
  notificationCursors,
  notificationDeliveries,
  notificationDigestItems,
  notificationRules,
  notificationSchedules,
  progressUpdates,
  readAttachment,
  requirements,
  resolveActor,
  subscriptions,
  tasks,
  wecomApps,
  workItems,
  workflowDefinitions,
} from '@flower/core';
import { createTestDb } from '@flower/core/testing';
import { seedInstance } from '@flower/core/testing/factories';
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildImportPlan } from '../src/plan';
import type { ImportOptions } from '../src/plan-types';
import { fileSummary, writeImport } from '../src/write';
import { INLINE_PNG, LEGACY_FILE, makeLegacyData, reviewedMapping, withPrdPages, withPushConfig } from './fixtures';

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
    await writeImport(t.adminDb, plan, { replace: true, confirmReplace: 'pan123' });
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
    await addRequirementComment(t.db, actor, created.id, { body: '引用 [[PAN-1]]' });
    expect(await t.adminDb.select().from(entityLinks)).toHaveLength(1);
    const area = await createStructureNode(t.db, actor, product!.id, { name: '导入后新建的业务域' });
    const mod = await createStructureNode(t.db, actor, product!.id, { parentId: area.id, name: '导入后模块' });
    const feature = await createStructureNode(t.db, actor, product!.id, { parentId: mod.id, name: '导入后功能点' });
    const prd = await createDocument(t.db, actor, product!.id, { title: '导入后 PRD' });
    await t.adminDb.insert(documentAffectedNodes).values({ orgId: actor.orgId, documentId: prd.id, nodeId: feature.id, changeType: 'added' });
    const [iteration] = await t.adminDb.select({ id: iterations.id }).from(iterations).where(eq(iterations.orgId, actor.orgId));
    await t.adminDb.insert(iterationScopeSnapshots).values({ orgId: actor.orgId, iterationId: iteration!.id, requirementId: created.id, snapshotKind: 'committed' });
    const [createdEvent] = await t.adminDb.select({ id: domainEvents.id }).from(domainEvents).where(eq(domainEvents.subjectId, created.id));
    const [ch] = await t.adminDb
      .insert(notificationChannels)
      .values({ orgId: actor.orgId, kind: 'wecom_robot', name: '导入后通道', config: 'v1:a:b:c', configHint: 'h', rateLimitPerMin: 20 })
      .returning();
    const [tpl] = await t.adminDb.insert(messageTemplates).values({ orgId: actor.orgId, name: '导入后模板', format: 'markdown', body: 'x' }).returning();
    const [sch] = await t.adminDb
      .insert(notificationSchedules)
      .values({ orgId: actor.orgId, productId: product!.id, name: '导入后摘要', cron: '0 18 * * *', source: 'digest', channelIds: [ch!.id], templateId: tpl!.id })
      .returning();
    const [rl] = await t.adminDb
      .insert(notificationRules)
      .values({ orgId: actor.orgId, productId: product!.id, name: '导入后规则', eventTypes: ['requirement.created'], mode: 'digest', digestScheduleId: sch!.id, templateId: tpl!.id })
      .returning();
    await t.adminDb.insert(notificationDigestItems).values({ orgId: actor.orgId, ruleId: rl!.id, scheduleId: sch!.id, eventId: createdEvent!.id });
    await t.adminDb.insert(notificationDeliveries).values({ orgId: actor.orgId, kind: 'rule', ruleId: rl!.id, channelId: ch!.id, eventId: createdEvent!.id });
    await t.adminDb.insert(memberNotifications).values({ orgId: actor.orgId, memberId: actor.memberId, eventId: createdEvent!.id, kind: 'mentioned', subjectType: 'requirement', subjectId: created.id, title: 't', body: 'b', url: '/u' });
    await t.adminDb.insert(subscriptions).values({ orgId: actor.orgId, memberId: actor.memberId, subjectType: 'requirement', subjectId: created.id, source: 'manual' });
    await t.adminDb.insert(wecomApps).values({ orgId: actor.orgId, corpId: 'ww1', agentId: '1', secret: 'v1:x', secretHint: '****' });

    const [wi] = await t.adminDb.insert(workItems).values({ orgId: actor.orgId, number: 1, title: '导入后工作项', createdBy: actor.memberId }).returning();
    await t.adminDb.insert(progressUpdates).values({ orgId: actor.orgId, workItemId: wi!.id, body: '工作项进展', authorMemberId: actor.memberId });
    await t.adminDb.insert(progressUpdates).values({ orgId: actor.orgId, requirementId: created.id, body: '需求进展', authorMemberId: actor.memberId });
    await t.adminDb.insert(blockers).values({ orgId: actor.orgId, workItemId: wi!.id, description: '工作项阻塞' });
    const [briefDoc] = await t.adminDb
      .insert(documents)
      .values({ orgId: actor.orgId, productId: product!.id, number: 1, kind: 'brief', source: 'native', title: '导入后简报', status: 'discussing' })
      .returning();
    await t.adminDb.insert(documentBriefs).values({ documentId: briefDoc!.id, orgId: actor.orgId, convertedDocumentId: prd.id });
    await t.adminDb.update(requirements).set({ briefDocumentId: briefDoc!.id }).where(eq(requirements.id, created.id));

    await writeImport(t.adminDb, plan, { replace: true, confirmReplace: 'pan123' });

    const after = (await resolveActor(t.db, opts.owner!.accountId, 'pan123'))!;
    const [p] = await listProducts(t.db, after);
    expect(p!.workflowVersionId).toBe(importedVersionId);
    expect((await listRequirements(t.db, after, p!.id)).total).toBe(5);
    expect(await t.adminDb.select().from(workflowDefinitions).where(isNotNull(workflowDefinitions.productId))).toEqual([]);
    expect(await t.adminDb.select().from(fieldDefinitions).where(isNotNull(fieldDefinitions.productId))).toEqual([]);
    expect(await t.adminDb.select().from(apiTokens)).toEqual([]);
    expect(await t.adminDb.select().from(iterationScopeSnapshots)).toEqual([]);
    expect(await t.adminDb.select().from(entityLinks)).toEqual([]);
    expect(await t.adminDb.select().from(documentAffectedNodes)).toEqual([]);
    for (const table of [notificationDigestItems, notificationDeliveries, notificationRules, notificationSchedules, messageTemplates, notificationChannels]) {
      expect(await t.adminDb.select().from(table)).toEqual([]);
    }
    for (const table of [memberNotifications, subscriptions, wecomApps]) expect(await t.adminDb.select().from(table)).toEqual([]);
    for (const table of [workItems, progressUpdates]) expect(await t.adminDb.select().from(table)).toEqual([]);
    expect(await t.adminDb.select().from(documentBriefs)).toEqual([]);
    expect(await t.adminDb.select().from(documents).where(eq(documents.kind, 'brief'))).toEqual([]);
    expect(await t.adminDb.select().from(blockers).where(isNotNull(blockers.workItemId))).toEqual([]);
    const [cursor] = await t.adminDb.select().from(notificationCursors).where(eq(notificationCursors.orgId, after.orgId));
    const [latest] = await t.adminDb.select({ id: domainEvents.id }).from(domainEvents).where(eq(domainEvents.orgId, after.orgId)).orderBy(desc(domainEvents.occurredAt), desc(domainEvents.id)).limit(1);
    expect(cursor!.lastEventId).toBe(latest!.id);
    expect(await t.adminDb.select().from(comments).where(eq(comments.body, '导入后的评论'))).toEqual([]);
  });

  it('覆盖时没有指定所有者账号则拒绝，原数据保持不变', async () => {
    const plan = buildImportPlan(makeLegacyData(), reviewedMapping(), { ...opts, owner: null });
    await expect(writeImport(t.adminDb, plan, { replace: true })).rejects.toThrow('--owner-email');
    const actor = (await resolveActor(t.db, opts.owner!.accountId, 'pan123'))!;
    expect(actor.orgRole).toBe('owner');
  });

  it('覆盖时没有 confirmReplace 则拒绝，原数据保持不变', async () => {
    const plan = buildImportPlan(makeLegacyData(), reviewedMapping(), { ...opts, orgSlug: 'confirm-missing' });
    await writeImport(t.adminDb, plan, { replace: false });
    const actor = (await resolveActor(t.db, opts.owner!.accountId, 'confirm-missing'))!;
    const [product] = await listProducts(t.db, actor);
    const before = (await listRequirements(t.db, actor, product!.id)).total;
    await expect(writeImport(t.adminDb, plan, { replace: true })).rejects.toThrow('--confirm-replace');
    expect((await listRequirements(t.db, actor, product!.id)).total).toBe(before);
  });

  it('confirmReplace 与组织 slug 不一致则拒绝，原数据保持不变', async () => {
    const plan = buildImportPlan(makeLegacyData(), reviewedMapping(), { ...opts, orgSlug: 'confirm-wrong' });
    await writeImport(t.adminDb, plan, { replace: false });
    const actor = (await resolveActor(t.db, opts.owner!.accountId, 'confirm-wrong'))!;
    const [product] = await listProducts(t.db, actor);
    const before = (await listRequirements(t.db, actor, product!.id)).total;
    await expect(writeImport(t.adminDb, plan, { replace: true, confirmReplace: 'confirm-wrong ' })).rejects.toThrow('slug');
    await expect(writeImport(t.adminDb, plan, { replace: true, confirmReplace: 'Confirm-wrong' })).rejects.toThrow('slug');
    expect((await listRequirements(t.db, actor, product!.id)).total).toBe(before);
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
    await writeImport(t.adminDb, buildImportPlan(data, reviewedMapping(), opts), { replace: true, confirmReplace: 'pan123' });
    const [row] = await t.adminDb.select({ planDays: tasks.planDays, delayDays: tasks.delayDays }).from(tasks).where(eq(tasks.title, '半天任务'));
    expect(row).toMatchObject({ planDays: 0.5, delayDays: 1.5 });
  });

  it('prd 页面：文档、修订、评论写入；附件文件从导出目录与内嵌图片写进存储', async () => {
    const uploads = mkdtempSync(path.join(os.tmpdir(), 'prd-uploads-'));
    writeFileSync(path.join(uploads, LEGACY_FILE), Buffer.from(INLINE_PNG, 'base64'));
    const storage = createLocalStorage(mkdtempSync(path.join(os.tmpdir(), 'flower-storage-')));
    const data = withPrdPages();
    const plan = buildImportPlan(data, reviewedMapping(data), { ...opts, orgSlug: 'prd123', uploadsDir: uploads });
    expect(await writeImport(t.adminDb, plan, { replace: false, storage, uploadsDir: uploads })).toEqual({ filesWritten: 2, filesMissing: 0 });
    const actor = (await resolveActor(t.db, opts.owner!.accountId, 'prd123'))!;
    const doc = await getDocumentByKey(t.db, actor, 'PAN-PRD-1');
    expect(doc).toMatchObject({ source: 'native', status: 'launched', revisionNumber: 3, requirements: [{ displayKey: 'PAN-1' }] });
    expect(await listDocumentComments(t.db, actor, doc.id)).toHaveLength(2);
    for (const att of plan.rows.attachments) {
      expect((await readAttachment(t.db, actor, { attachmentId: att.id!, storage })).mime).toBe('image/png');
    }
    await writeImport(t.adminDb, plan, { replace: true, confirmReplace: 'prd123', storage, uploadsDir: uploads });
    expect((await getDocumentByKey(t.db, actor, 'PAN-PRD-1')).revisionNumber).toBe(3);
  });

  it('没给导出目录时照常写入，旧附件文件计为缺失', async () => {
    const storage = createLocalStorage(mkdtempSync(path.join(os.tmpdir(), 'flower-storage-')));
    const data = withPrdPages();
    const plan = buildImportPlan(data, reviewedMapping(data), { ...opts, orgSlug: 'prd-missing' });
    expect(plan.report.documents.missingFiles).toBeNull();
    expect(await writeImport(t.adminDb, plan, { replace: false, storage })).toEqual({ filesWritten: 1, filesMissing: 1 });
    expect(await writeImport(t.adminDb, plan, { replace: true, confirmReplace: 'prd-missing' })).toEqual({ filesWritten: 0, filesMissing: 2 });
  });

  it('导入后新建的 PRD 编号接着导入的最大编号；有了新文档、评论与需求关联后仍可 replace，数量回到导入时', async () => {
    const data = withPrdPages();
    const plan = buildImportPlan(data, reviewedMapping(data), { ...opts, orgSlug: 'prd-replace' });
    await writeImport(t.adminDb, plan, { replace: false });
    const actor = (await resolveActor(t.db, opts.owner!.accountId, 'prd-replace'))!;
    const [product] = await listProducts(t.db, actor);
    const x002 = await getRequirementByKey(t.db, actor, 'PAN-2');
    const created = await createDocument(t.db, actor, product!.id, { title: '导入后新建的 PRD', requirementIds: [x002.id] });
    expect(created.displayKey).toBe('PAN-PRD-3');
    const imported = await getDocumentByKey(t.db, actor, 'PAN-PRD-1');
    await addDocumentComment(t.db, actor, imported.id, { body: '导入后的 PRD 评论' });

    await writeImport(t.adminDb, plan, { replace: true, confirmReplace: 'prd-replace' });

    const count = async (table: typeof documents | typeof documentRevisions | typeof attachments | typeof comments) =>
      (await t.adminDb.select().from(table).where(eq(table.orgId, actor.orgId))).length;
    expect(await count(documents)).toBe(2);
    expect(await count(documentRevisions)).toBe(4);
    expect(await count(attachments)).toBe(2);
    expect((await t.adminDb.select().from(comments).where(eq(comments.orgId, actor.orgId))).filter((c) => c.targetType === 'document')).toHaveLength(2);
    expect(await t.adminDb.select().from(requirements).where(and(eq(requirements.orgId, actor.orgId), isNotNull(requirements.changeDocumentId)))).toHaveLength(1);
    const after = (await resolveActor(t.db, opts.owner!.accountId, 'prd-replace'))!;
    expect((await createDocument(t.db, after, product!.id, { title: '覆盖后新建的 PRD' })).displayKey).toBe('PAN-PRD-3');
  });

  it('旧附件文件内容不合格或键跳出导出目录时，不建附件、不读取、不写入存储', async () => {
    const parent = mkdtempSync(path.join(os.tmpdir(), 'prd-parent-'));
    const uploads = path.join(parent, 'uploads');
    mkdirSync(uploads);
    writeFileSync(path.join(uploads, LEGACY_FILE), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    writeFileSync(path.join(parent, 'outside.png'), Buffer.from(INLINE_PNG, 'base64'));
    for (const [slug, key] of [['prd-rejected', LEGACY_FILE], ['prd-escape', '../outside.png']] as const) {
      const storage = createLocalStorage(mkdtempSync(path.join(os.tmpdir(), 'flower-storage-')));
      const data = withPrdPages();
      data.prd.attachments[0]!.storage_key = key;
      const plan = buildImportPlan(data, reviewedMapping(data), { ...opts, orgSlug: slug, uploadsDir: uploads });
      expect(await writeImport(t.adminDb, plan, { replace: false, storage, uploadsDir: uploads })).toEqual({ filesWritten: 1, filesMissing: 0 });
      const actor = (await resolveActor(t.db, opts.owner!.accountId, slug))!;
      const rows = await t.adminDb.select().from(attachments).where(eq(attachments.orgId, actor.orgId));
      expect(rows.map((r) => r.filename)).toEqual([expect.stringMatching(/^inline-/)]);
    }
  });

  it('推送配置：通道停用、配置能用同一个 FLOWER_SECRET_KEY 解开；定时推送没有排期；迁移记录写入', async () => {
    const key = 'migrate-test-secret-migrate-test-secret-01';
    await writeImport(t.adminDb, buildImportPlan(withPushConfig(), reviewedMapping(), { ...opts, secretKey: key }), { replace: true, confirmReplace: 'pan123' });
    const actor = (await resolveActor(t.db, opts.owner!.accountId, 'pan123'))!;
    const channels = await listChannels(t.db, actor, { secretKey: key });
    expect(channels.map((c) => [c.name, c.enabled])).toEqual(
      expect.arrayContaining([
        ['产品群', false],
        ['123plane 邮件', false],
      ]),
    );
    expect(channels.find((c) => c.name === '123plane 邮件')!.settings).toMatchObject({ host: 'smtp.example.com', to: ['pm@example.com', 'dev@example.com'] });
    expect(JSON.stringify(channels)).not.toContain('demo-smtp-pass');
    const schedules = await listSchedules(t.db, actor);
    expect(schedules.every((s) => s.nextRunAt === null)).toBe(true);
    expect(await t.adminDb.select().from(notificationDeliveries)).toHaveLength(2);
  });

  it('导入后为处于未开始、进行中类别的需求回填加入跟进的时间', async () => {
    const [row] = (await t.adminDb.execute(sql`
      with st as (
        select p.id as product_id, s->>'key' as key, s->>'category' as category
        from products p join organizations o on o.id = p.org_id and o.slug = 'pan123'
        join workflow_versions v on v.id = p.workflow_version_id, jsonb_array_elements(v.body->'states') s
      )
      select count(*) filter (where st.category in ('unstarted', 'started'))::int as expected,
             count(r.tracked_since)::int as tracked
      from requirements r join st on st.product_id = r.product_id and st.key = r.state_key
      where r.deleted_at is null`)) as unknown as [{ expected: number; tracked: number }];
    expect(row.expected).toBeGreaterThan(0);
    expect(row.tracked).toBe(row.expected);
  });
});

describe('附件文件输出', () => {
  it('--replace 时提示存储目录里原有的文件不会清理', () => {
    expect(fileSummary('/srv/storage', { filesWritten: 3, filesMissing: 1 }, false)).toEqual(['附件文件：写入 3 个，缺失 1 个。']);
    expect(fileSummary(undefined, { filesWritten: 0, filesMissing: 2 }, true)).toEqual([
      '未指定 --storage，附件文件 2 个没有写入。',
      '注意：--replace 只删除数据库中的数据，附件存储目录里原有的文件不会清理，没有引用的旧文件会留在那里。',
    ]);
  });
});
