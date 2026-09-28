import { and, asc, eq, isNull } from 'drizzle-orm';
import { productRoleOf, requireOrgAdmin, requireProductRole } from '../access/permissions';
import type { Db } from '../db/client';
import { members, productMembers, products, workflowDefinitions, workflowVersions } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor, ProductRole } from '../domain-types';
import { AppError, isUniqueViolation } from '../errors';
import { recordEvent } from '../events';

export const PRODUCT_KEY_RE = /^[A-Z][A-Z0-9]{1,9}$/;

export type ProductView = {
  id: string;
  key: string;
  name: string;
  status: 'active' | 'archived';
  workflowVersionId: string | null;
  structureLevelNames: string[] | null;
  myRole: ProductRole;
};

const toView = (p: typeof products.$inferSelect, myRole: ProductRole): ProductView => ({
  id: p.id,
  key: p.key,
  name: p.name,
  status: p.status,
  workflowVersionId: p.workflowVersionId,
  structureLevelNames: p.structureLevelNames,
  myRole,
});

function assertName(name: string): string {
  const n = name.trim();
  if (!n || n.length > 50) throw new AppError('invalid', '产品名称不能为空，且不超过 50 个字符');
  return n;
}

async function loadProduct(tx: Tx, productId: string) {
  const [p] = await tx.select().from(products).where(and(eq(products.id, productId), isNull(products.deletedAt)));
  if (!p) throw new AppError('not_found', '产品不存在');
  return p;
}

async function defaultWorkflowVersion(tx: Tx): Promise<string | null> {
  const [def] = await tx
    .select()
    .from(workflowDefinitions)
    .where(and(isNull(workflowDefinitions.productId), isNull(workflowDefinitions.archivedAt)))
    .orderBy(asc(workflowDefinitions.createdAt))
    .limit(1);
  return def?.currentVersionId ?? null;
}

export async function createProduct(
  db: Db,
  actor: Actor,
  input: { name: string; key: string; workflowVersionId?: string },
): Promise<ProductView> {
  requireOrgAdmin(actor);
  const name = assertName(input.name);
  const key = input.key.trim().toUpperCase();
  if (!PRODUCT_KEY_RE.test(key)) throw new AppError('invalid', '编号前缀须以字母开头，由 2–10 位大写字母或数字组成');
  return withOrg(db, actor.orgId, async (tx) => {
    let workflowVersionId: string | null;
    if (input.workflowVersionId) {
      const [row] = await tx
        .select({ definitionProductId: workflowDefinitions.productId })
        .from(workflowVersions)
        .innerJoin(workflowDefinitions, eq(workflowDefinitions.id, workflowVersions.definitionId))
        .where(eq(workflowVersions.id, input.workflowVersionId));
      if (!row) throw new AppError('not_found', '流程版本不存在');
      if (row.definitionProductId !== null) throw new AppError('invalid', '新产品只能使用组织流程模板');
      workflowVersionId = input.workflowVersionId;
    } else {
      workflowVersionId = await defaultWorkflowVersion(tx);
    }
    let row: typeof products.$inferSelect;
    try {
      [row] = (await tx
        .insert(products)
        .values({ orgId: actor.orgId, name, key, workflowVersionId })
        .returning()) as [typeof products.$inferSelect];
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppError('conflict', `编号前缀 ${key} 已被使用`);
      throw e;
    }
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: row.id,
      type: 'product.created',
      subjectType: 'product',
      subjectId: row.id,
      actor,
      payload: { name, key },
    });
    return toView(row, 'admin');
  });
}

export async function listProducts(db: Db, actor: Actor): Promise<ProductView[]> {
  return withOrg(db, actor.orgId, async (tx) => {
    const rows = await tx.select().from(products).where(isNull(products.deletedAt)).orderBy(asc(products.createdAt));
    const result: ProductView[] = [];
    for (const p of rows) {
      const role = await productRoleOf(tx, actor, p.id);
      if (role) result.push(toView(p, role));
    }
    return result;
  });
}

export async function getProduct(db: Db, actor: Actor, productId: string): Promise<ProductView> {
  return withOrg(db, actor.orgId, async (tx) => {
    const role = await requireProductRole(tx, actor, productId, 'viewer');
    return toView(await loadProduct(tx, productId), role);
  });
}

export async function updateProduct(
  db: Db,
  actor: Actor,
  productId: string,
  input: { name?: string; status?: 'active' | 'archived' },
): Promise<ProductView> {
  return withOrg(db, actor.orgId, async (tx) => {
    const role = await requireProductRole(tx, actor, productId, 'admin');
    const cur = await loadProduct(tx, productId);
    const name = input.name === undefined ? cur.name : assertName(input.name);
    const status = input.status ?? cur.status;
    const [row] = await tx.update(products).set({ name, status }).where(eq(products.id, productId)).returning();
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId,
      type: 'product.updated',
      subjectType: 'product',
      subjectId: productId,
      actor,
      payload: {
        changes: [
          { field: 'name', old: cur.name, new: name },
          { field: 'status', old: cur.status, new: status },
        ].filter((c) => c.old !== c.new),
      },
    });
    return toView(row!, role);
  });
}

export async function listProductRoles(db: Db, actor: Actor, productId: string): Promise<Array<{ memberId: string; role: ProductRole }>> {
  return withOrg(db, actor.orgId, async (tx) => {
    await requireProductRole(tx, actor, productId, 'admin');
    return tx
      .select({ memberId: productMembers.memberId, role: productMembers.role })
      .from(productMembers)
      .where(eq(productMembers.productId, productId));
  });
}

export async function setProductRole(
  db: Db,
  actor: Actor,
  productId: string,
  memberId: string,
  role: ProductRole | null,
): Promise<void> {
  return withOrg(db, actor.orgId, async (tx) => {
    await requireProductRole(tx, actor, productId, 'admin');
    const [target] = await tx.select().from(members).where(eq(members.id, memberId));
    if (!target) throw new AppError('not_found', '成员不存在');
    if (target.orgRole === 'owner' || target.orgRole === 'admin') {
      throw new AppError('invalid', '组织管理员在所有产品上都是管理员，无需单独设置');
    }
    const [existing] = await tx
      .select({ role: productMembers.role })
      .from(productMembers)
      .where(and(eq(productMembers.productId, productId), eq(productMembers.memberId, memberId)));
    await tx
      .delete(productMembers)
      .where(and(eq(productMembers.productId, productId), eq(productMembers.memberId, memberId)));
    if (role) await tx.insert(productMembers).values({ orgId: actor.orgId, productId, memberId, role });
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId,
      type: 'product.member_role_set',
      subjectType: 'member',
      subjectId: memberId,
      actor,
      payload: { changes: [{ field: 'role', old: existing?.role ?? null, new: role }] },
    });
  });
}
