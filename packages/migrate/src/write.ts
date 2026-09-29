import * as core from '@flower/core';
import type { Db, Tx } from '@flower/core';
import { eq, sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
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

/** 删除一个组织的全部租户数据（以 flower_admin 执行，不受 RLS 与 domain_events 只追加的限制）。 */
export async function deleteOrgData(tx: Tx, orgId: string): Promise<void> {
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

export async function writeImport(adminDb: Db, plan: ImportPlan, opts: { replace: boolean }): Promise<void> {
  if (plan.report.problems.length > 0) throw new Error(`导入计划有 ${plan.report.problems.length} 个问题，拒绝写入。请先处理对账报告中的问题。`);
  const org = plan.rows.organizations[0]!;
  await adminDb.transaction(async (tx) => {
    const [existing] = await tx.select({ id: core.organizations.id }).from(core.organizations).where(eq(core.organizations.slug, org.slug));
    if (existing) {
      if (!opts.replace) throw new Error(`组织「${org.slug}」已存在；确认要用本次导入覆盖时加 --replace`);
      await deleteOrgData(tx, existing.id);
    }
    for (const key of INSERT_ORDER) {
      const rows = (key === 'workflowDefinitions' ? plan.rows.workflowDefinitions.map((d) => ({ ...d, currentVersionId: null })) : plan.rows[key]) as unknown[];
      for (let i = 0; i < rows.length; i += CHUNK) await tx.insert(TABLES[key]).values(rows.slice(i, i + CHUNK) as never);
      if (key === 'workflowVersions') {
        for (const d of plan.rows.workflowDefinitions) {
          await tx.update(core.workflowDefinitions).set({ currentVersionId: d.currentVersionId }).where(eq(core.workflowDefinitions.id, d.id!));
        }
      }
    }
  });
}
