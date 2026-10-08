import { existsSync, readFileSync } from 'node:fs';
import * as core from '@flower/core';
import type { Db, FileStorage, Tx } from '@flower/core';
import { eq, sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { checkImage, resolveUpload } from './plan-documents';
import { type ImportPlan, type ImportRows, INSERT_ORDER } from './plan-types';

const TABLES: Record<keyof ImportRows, PgTable> = {
  organizations: core.organizations,
  members: core.members,
  functionTags: core.functionTags,
  memberFunctionTags: core.memberFunctionTags,
  workflowDefinitions: core.workflowDefinitions,
  workflowVersions: core.workflowVersions,
  products: core.products,
  productMembers: core.productMembers,
  fieldDefinitions: core.fieldDefinitions,
  fieldOptions: core.fieldOptions,
  structureNodes: core.structureNodes,
  documentTemplates: core.documentTemplates,
  documents: core.documents,
  documentRevisions: core.documentRevisions,
  attachments: core.attachments,
  iterations: core.iterations,
  releases: core.releases,
  requirements: core.requirements,
  fieldValues: core.fieldValues,
  requirementAssignments: core.requirementAssignments,
  requirementRelations: core.requirementRelations,
  stateTransitions: core.stateTransitions,
  blockers: core.blockers,
  checkItemResults: core.checkItemResults,
  checkItemSignoffs: core.checkItemSignoffs,
  requirementReleases: core.requirementReleases,
  tasks: core.tasks,
  comments: core.comments,
  commentReads: core.commentReads,
  entityAliases: core.entityAliases,
  domainEvents: core.domainEvents,
};
const CHUNK = 500;

/** 附件文件写入结果：rejected 为内容不是支持的图片或超过 10 MB 而没有写入的旧附件文件。 */
export type WriteFilesResult = {
  filesWritten: number;
  filesMissing: number;
  /** 旧附件键为绝对路径或会跳出导出目录，没有读取。 */
  filesInvalid: number;
  rejected: Array<{ document: string; storageKey: string; reason: string }>;
};

/** 删除一个组织的全部租户数据（以 flower_admin 执行，不受 RLS 与 domain_events 只追加的限制）。 */
export async function deleteOrgData(tx: Tx, orgId: string): Promise<void> {
  await tx.update(core.documents).set({ currentRevisionId: null }).where(eq(core.documents.orgId, orgId));
  await tx.update(core.products).set({ workflowVersionId: null }).where(eq(core.products.orgId, orgId));
  await tx
    .update(core.workflowDefinitions)
    .set({ productId: null, currentVersionId: null, forkedFromVersionId: null })
    .where(eq(core.workflowDefinitions.orgId, orgId));
  // 导入不写、但正常使用会写的租户表：迭代快照在需求/迭代之前删，Token 与邀请在成员之前删
  await tx.execute(sql`delete from ${core.iterationScopeSnapshots} where org_id = ${orgId}`);
  const tenantTables = [...INSERT_ORDER].reverse().filter((k) => k !== 'organizations').map((k) => TABLES[k]);
  for (const table of [...tenantTables.slice(0, -1), core.invitations, core.apiTokens, tenantTables.at(-1)!]) {
    await tx.execute(sql`delete from ${table} where org_id = ${orgId}`);
  }
  await tx.delete(core.organizations).where(eq(core.organizations.id, orgId));
}

export async function writeImport(
  adminDb: Db,
  plan: ImportPlan,
  opts: { replace: boolean; storage?: FileStorage; uploadsDir?: string },
): Promise<WriteFilesResult> {
  if (plan.report.problems.length > 0) throw new Error(`导入计划有 ${plan.report.problems.length} 个问题，拒绝写入。请先处理对账报告中的问题。`);
  const org = plan.rows.organizations[0]!;
  await adminDb.transaction(async (tx) => {
    const [existing] = await tx.select({ id: core.organizations.id }).from(core.organizations).where(eq(core.organizations.slug, org.slug));
    if (existing) {
      if (!opts.replace) throw new Error(`组织「${org.slug}」已存在；确认要用本次导入覆盖时加 --replace`);
      // 覆盖会删掉现有的全部成员关系；计划里没有关联账号的所有者时，覆盖后就没有任何账号能进入该组织
      if (!plan.rows.members.some((m) => m.accountId && m.orgRole === 'owner')) {
        throw new Error(`覆盖组织「${org.slug}」时必须用 --owner-email 指定所有者账号，否则覆盖后没有任何账号能登录该组织`);
      }
      await deleteOrgData(tx, existing.id);
    }
    for (const key of INSERT_ORDER) {
      // 与当前版本 / 当前修订互相引用的两张表先不写引用，等被引用的行写完再补
      const rows = (
        key === 'workflowDefinitions'
          ? plan.rows.workflowDefinitions.map((d) => ({ ...d, currentVersionId: null }))
          : key === 'documents'
            ? plan.rows.documents.map((d) => ({ ...d, currentRevisionId: null }))
            : plan.rows[key]
      ) as unknown[];
      for (let i = 0; i < rows.length; i += CHUNK) await tx.insert(TABLES[key]).values(rows.slice(i, i + CHUNK) as never);
      if (key === 'workflowVersions') {
        for (const d of plan.rows.workflowDefinitions) {
          await tx.update(core.workflowDefinitions).set({ currentVersionId: d.currentVersionId }).where(eq(core.workflowDefinitions.id, d.id!));
        }
      }
      if (key === 'documentRevisions') {
        for (const d of plan.rows.documents) {
          if (d.currentRevisionId) await tx.update(core.documents).set({ currentRevisionId: d.currentRevisionId }).where(eq(core.documents.id, d.id!));
        }
      }
    }
  });
  // 数据库提交后再写文件：键由来源确定，重复导入覆盖同一个文件
  const result: WriteFilesResult = { filesWritten: 0, filesMissing: 0, filesInvalid: 0, rejected: [] };
  if (!opts.storage) return { ...result, filesMissing: plan.files.length };
  const attachmentByKey = new Map(plan.rows.attachments.map((a) => [a.storageKey, a]));
  const productKey = plan.rows.products[0]?.key;
  const documentKey = (documentId: string) => `${productKey}-PRD-${plan.rows.documents.find((d) => d.id === documentId)?.number}`;
  for (const f of plan.files) {
    let bytes: Uint8Array | null = null;
    if ('base64' in f.from) bytes = Buffer.from(f.from.base64, 'base64');
    else {
      const file = opts.uploadsDir ? resolveUpload(opts.uploadsDir, f.from.legacyKey) : null;
      if (opts.uploadsDir && !file) {
        result.filesInvalid += 1;
        continue;
      }
      if (file && existsSync(file)) bytes = readFileSync(file);
      // 旧附件按内容再校验一次，与应用上传的约束一致；内嵌图片在计划阶段已校验
      const att = attachmentByKey.get(f.storageKey)!;
      const reason = bytes ? checkImage(bytes, att.mime) : null;
      if (reason) {
        result.rejected.push({ document: documentKey(att.targetId), storageKey: f.storageKey, reason });
        continue;
      }
    }
    if (!bytes) {
      result.filesMissing += 1;
      continue;
    }
    await opts.storage.put(f.storageKey, bytes);
    result.filesWritten += 1;
  }
  return result;
}
