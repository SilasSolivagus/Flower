import { and, asc, desc, eq, isNull, or } from 'drizzle-orm';
import { requireOrgAdmin, requireProductRole } from '../access/permissions';
import type { Db } from '../db/client';
import { fieldDefinitions, products, workflowDefinitions, workflowVersions } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import { validateWorkflowBody, type WorkflowBody } from './workflow-schema';

export type WorkflowDefinitionView = {
  id: string;
  name: string;
  productId: string | null;
  currentVersionId: string | null;
  currentVersion: number | null;
  forkedFromVersionId: string | null;
  archivedAt: Date | null;
};

export type WorkflowVersionView = {
  id: string;
  definitionId: string;
  version: number;
  body: WorkflowBody;
  note: string | null;
  createdAt: Date;
};

type DefRow = typeof workflowDefinitions.$inferSelect;
type VerRow = typeof workflowVersions.$inferSelect;

const versionView = (v: VerRow): WorkflowVersionView => ({
  id: v.id,
  definitionId: v.definitionId,
  version: v.version,
  body: v.body as WorkflowBody,
  note: v.note,
  createdAt: v.createdAt,
});

async function definitionView(tx: Tx, d: DefRow): Promise<WorkflowDefinitionView> {
  let currentVersion: number | null = null;
  if (d.currentVersionId) {
    const [v] = await tx.select({ version: workflowVersions.version }).from(workflowVersions).where(eq(workflowVersions.id, d.currentVersionId));
    currentVersion = v?.version ?? null;
  }
  return {
    id: d.id,
    name: d.name,
    productId: d.productId,
    currentVersionId: d.currentVersionId,
    currentVersion,
    forkedFromVersionId: d.forkedFromVersionId,
    archivedAt: d.archivedAt,
  };
}

/** 流程条件可引用的字段：组织字段，加上产品覆盖字段。 */
async function fieldKeysFor(tx: Tx, productId: string | null): Promise<string[]> {
  const rows = await tx
    .select({ key: fieldDefinitions.key })
    .from(fieldDefinitions)
    .where(productId ? or(isNull(fieldDefinitions.productId), eq(fieldDefinitions.productId, productId)) : isNull(fieldDefinitions.productId));
  return [...new Set(rows.map((r) => r.key))];
}

async function validateOrThrow(tx: Tx, body: unknown, productId: string | null): Promise<WorkflowBody> {
  const r = validateWorkflowBody(body, { fieldKeys: await fieldKeysFor(tx, productId) });
  if (!r.ok) throw new AppError('invalid', '流程定义有误', r.issues);
  return r.body;
}

async function loadDefinition(tx: Tx, id: string): Promise<DefRow> {
  const [d] = await tx.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, id));
  if (!d) throw new AppError('not_found', '流程不存在');
  return d;
}

/** 模板由组织管理员管理；产品覆盖由产品管理员管理。 */
async function requireManage(tx: Tx, actor: Actor, d: DefRow): Promise<void> {
  if (d.productId) await requireProductRole(tx, actor, d.productId, 'admin');
  else requireOrgAdmin(actor);
}

async function insertVersion(tx: Tx, actor: Actor, d: DefRow, body: WorkflowBody, note: string | null): Promise<VerRow> {
  const [last] = await tx
    .select({ version: workflowVersions.version })
    .from(workflowVersions)
    .where(eq(workflowVersions.definitionId, d.id))
    .orderBy(desc(workflowVersions.version))
    .limit(1);
  const [v] = await tx
    .insert(workflowVersions)
    .values({ orgId: actor.orgId, definitionId: d.id, version: (last?.version ?? 0) + 1, body, note, createdBy: actor.memberId })
    .returning();
  await tx.update(workflowDefinitions).set({ currentVersionId: v!.id }).where(eq(workflowDefinitions.id, d.id));
  await recordEvent(tx, {
    orgId: actor.orgId,
    productId: d.productId,
    type: 'workflow.version_published',
    subjectType: 'workflow_definition',
    subjectId: d.id,
    actor,
    payload: { version: v!.version, note },
  });
  return v!;
}

export async function listWorkflowTemplates(db: Db, actor: Actor): Promise<WorkflowDefinitionView[]> {
  requireOrgAdmin(actor);
  return withOrg(db, actor.orgId, async (tx) => {
    const rows = await tx
      .select()
      .from(workflowDefinitions)
      .where(isNull(workflowDefinitions.productId))
      .orderBy(asc(workflowDefinitions.createdAt));
    return Promise.all(rows.map((d) => definitionView(tx, d)));
  });
}

export async function getWorkflowDefinition(
  db: Db,
  actor: Actor,
  definitionId: string,
): Promise<{ definition: WorkflowDefinitionView; versions: WorkflowVersionView[] }> {
  return withOrg(db, actor.orgId, async (tx) => {
    const d = await loadDefinition(tx, definitionId);
    await requireManage(tx, actor, d);
    const versions = await tx
      .select()
      .from(workflowVersions)
      .where(eq(workflowVersions.definitionId, d.id))
      .orderBy(desc(workflowVersions.version));
    return { definition: await definitionView(tx, d), versions: versions.map(versionView) };
  });
}

export async function createWorkflowTemplate(
  db: Db,
  actor: Actor,
  input: { name: string; body: unknown; note?: string },
): Promise<{ definition: WorkflowDefinitionView; version: WorkflowVersionView }> {
  requireOrgAdmin(actor);
  const name = input.name.trim();
  if (!name || name.length > 30) throw new AppError('invalid', '流程名称不能为空，且不超过 30 个字符');
  return withOrg(db, actor.orgId, async (tx) => {
    const body = await validateOrThrow(tx, input.body, null);
    const [d] = await tx.insert(workflowDefinitions).values({ orgId: actor.orgId, name }).returning();
    const v = await insertVersion(tx, actor, d!, body, input.note ?? null);
    return { definition: await definitionView(tx, await loadDefinition(tx, d!.id)), version: versionView(v) };
  });
}

export async function publishWorkflowVersion(
  db: Db,
  actor: Actor,
  definitionId: string,
  input: { body: unknown; note?: string },
): Promise<WorkflowVersionView> {
  return withOrg(db, actor.orgId, async (tx) => {
    const d = await loadDefinition(tx, definitionId);
    await requireManage(tx, actor, d);
    const body = await validateOrThrow(tx, input.body, d.productId);
    return versionView(await insertVersion(tx, actor, d, body, input.note ?? null));
  });
}

export async function forkWorkflowForProduct(
  db: Db,
  actor: Actor,
  productId: string,
  input: { fromVersionId: string },
): Promise<{ definition: WorkflowDefinitionView; version: WorkflowVersionView }> {
  return withOrg(db, actor.orgId, async (tx) => {
    await requireProductRole(tx, actor, productId, 'admin');
    const [src] = await tx.select().from(workflowVersions).where(eq(workflowVersions.id, input.fromVersionId));
    if (!src) throw new AppError('not_found', '流程版本不存在');
    const srcDef = await loadDefinition(tx, src.definitionId);
    const [product] = await tx.select().from(products).where(eq(products.id, productId));
    const [d] = await tx
      .insert(workflowDefinitions)
      .values({ orgId: actor.orgId, productId, name: `${product!.name}的流程（基于${srcDef.name}）`, forkedFromVersionId: src.id })
      .returning();
    const v = await insertVersion(tx, actor, d!, src.body as WorkflowBody, `复制自「${srcDef.name}」v${src.version}`);
    await tx.update(products).set({ workflowVersionId: v.id }).where(eq(products.id, productId));
    return { definition: await definitionView(tx, await loadDefinition(tx, d!.id)), version: versionView(v) };
  });
}

export async function setProductWorkflowVersion(db: Db, actor: Actor, productId: string, versionId: string): Promise<void> {
  return withOrg(db, actor.orgId, async (tx) => {
    await requireProductRole(tx, actor, productId, 'admin');
    const [row] = await tx
      .select({ version: workflowVersions, definition: workflowDefinitions })
      .from(workflowVersions)
      .innerJoin(workflowDefinitions, eq(workflowDefinitions.id, workflowVersions.definitionId))
      .where(eq(workflowVersions.id, versionId));
    if (!row) throw new AppError('not_found', '流程版本不存在');
    if (row.definition.productId !== null && row.definition.productId !== productId) {
      throw new AppError('invalid', '不能使用其他产品的流程');
    }
    const [before] = await tx.select({ v: products.workflowVersionId }).from(products).where(eq(products.id, productId));
    await tx.update(products).set({ workflowVersionId: versionId }).where(eq(products.id, productId));
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId,
      type: 'product.workflow_changed',
      subjectType: 'product',
      subjectId: productId,
      actor,
      payload: { changes: [{ field: 'workflowVersionId', old: before?.v ?? null, new: versionId }] },
    });
  });
}

export async function getProductWorkflow(
  db: Db,
  actor: Actor,
  productId: string,
): Promise<{ definition: WorkflowDefinitionView; version: WorkflowVersionView }> {
  return withOrg(db, actor.orgId, async (tx) => {
    await requireProductRole(tx, actor, productId, 'viewer');
    const [row] = await tx
      .select({ version: workflowVersions, definition: workflowDefinitions })
      .from(products)
      .innerJoin(workflowVersions, eq(workflowVersions.id, products.workflowVersionId))
      .innerJoin(workflowDefinitions, eq(workflowDefinitions.id, workflowVersions.definitionId))
      .where(and(eq(products.id, productId)));
    if (!row) throw new AppError('not_found', '该产品尚未指定流程');
    return { definition: await definitionView(tx, row.definition), version: versionView(row.version) };
  });
}
