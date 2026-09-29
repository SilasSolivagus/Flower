import { and, asc, desc, eq, isNull, or } from 'drizzle-orm';
import { requireProductRole } from '../access/permissions';
import type { Db } from '../db/client';
import { iterations, structureNodes } from '../db/schema';
import { withOrg } from '../db/tx';
import type { Actor } from '../domain-types';

export type StructureNodeView = { id: string; parentId: string | null; depth: number; name: string; status: 'active' | 'deprecated'; sort: number };
export type IterationBrief = {
  id: string;
  name: string;
  type: 'regular' | 'special';
  status: 'planning' | 'active' | 'done' | 'canceled';
  startDate: string;
  endDate: string;
};

export async function listStructureNodes(db: Db, actor: Actor, productId: string): Promise<StructureNodeView[]> {
  return withOrg(db, actor.orgId, async (tx) => {
    await requireProductRole(tx, actor, productId, 'viewer');
    const rows = await tx.select().from(structureNodes).where(eq(structureNodes.productId, productId)).orderBy(asc(structureNodes.depth), asc(structureNodes.sort), asc(structureNodes.name));
    return rows.map((n) => ({ id: n.id, parentId: n.parentId, depth: n.depth, name: n.name, status: n.status, sort: n.sort }));
  });
}

export async function listProductIterations(db: Db, actor: Actor, productId: string): Promise<IterationBrief[]> {
  return withOrg(db, actor.orgId, async (tx) => {
    await requireProductRole(tx, actor, productId, 'viewer');
    const rows = await tx
      .select()
      .from(iterations)
      .where(and(isNull(iterations.deletedAt), or(eq(iterations.productId, productId), eq(iterations.type, 'special'))))
      .orderBy(desc(iterations.startDate), asc(iterations.name));
    return rows.map((i) => ({ id: i.id, name: i.name, type: i.type, status: i.status, startDate: i.startDate, endDate: i.endDate }));
  });
}
