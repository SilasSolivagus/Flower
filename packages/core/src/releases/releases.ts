import { and, desc, eq, inArray, isNull, type SQL, sql } from 'drizzle-orm';
import { atLeast, productRoleOf, requireProductRole, visibleProductIds } from '../access/permissions';
import { assertIsoDate } from '../dates';
import type { Db } from '../db/client';
import { fieldOptions, iterations, products, releases, requirementReleases, requirements } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import type { Actor, ProductRole } from '../domain-types';
import { AppError } from '../errors';
import { recordEvent } from '../events';
import { effectiveFields, loadRequirement } from '../requirements/context';
import type { OptionRef } from '../requirements/requirements';

export type ReleaseView = {
  id: string;
  productId: string;
  productKey: string;
  versionName: string;
  platform: OptionRef | null;
  iteration: { id: string; name: string } | null;
  status: 'planned' | 'released';
  plannedDate: string | null;
  baselineDate: string | null;
  releasedAt: Date | null;
  notes: string | null;
  requirementCount: number;
  canEdit: boolean;
};

type ReleaseRow = typeof releases.$inferSelect;

function assertVersionName(v: string): string {
  const n = v.trim();
  if (!n || n.length > 50) throw new AppError('invalid', '版本号不能为空，且不超过 50 个字符');
  return n;
}

function assertNotes(v: string | null | undefined): string | null {
  const n = v?.trim() || null;
  if (n && n.length > 2000) throw new AppError('invalid', '说明不超过 2000 个字符');
  return n;
}

async function assertPlatformOption(tx: Tx, productId: string, optionId: string, previous: string | null): Promise<void> {
  const platform = (await effectiveFields(tx, productId)).get('platform');
  const opt = platform?.options.find((o) => o.id === optionId);
  if (!opt) throw new AppError('invalid', '平台选项不属于本产品的「平台」字段');
  if (!opt.active && optionId !== previous) throw new AppError('invalid', `选项「${opt.label}」已停用`);
}

async function assertReleaseIteration(tx: Tx, productId: string, iterationId: string): Promise<void> {
  const [it] = await tx.select().from(iterations).where(and(eq(iterations.id, iterationId), isNull(iterations.deletedAt)));
  if (!it) throw new AppError('not_found', '迭代不存在');
  if (it.type === 'regular' && it.productId !== productId) throw new AppError('invalid', '不能关联其他产品的迭代');
}

async function loadRelease(tx: Tx, id: string): Promise<ReleaseRow> {
  const [row] = await tx.select().from(releases).where(eq(releases.id, id));
  if (!row) throw new AppError('not_found', '发布版本不存在');
  return row;
}

async function views(tx: Tx, actor: Actor, rows: ReleaseRow[]): Promise<ReleaseView[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const productIds = [...new Set(rows.map((r) => r.productId))];
  const prods = await tx.select({ id: products.id, key: products.key }).from(products).where(inArray(products.id, productIds));
  const optionIds = [...new Set(rows.map((r) => r.platformOptionId).filter((x): x is string => !!x))];
  const opts = optionIds.length ? await tx.select().from(fieldOptions).where(inArray(fieldOptions.id, optionIds)) : [];
  const iterIds = [...new Set(rows.map((r) => r.iterationId).filter((x): x is string => !!x))];
  const iters = iterIds.length ? await tx.select({ id: iterations.id, name: iterations.name }).from(iterations).where(inArray(iterations.id, iterIds)) : [];
  const counts = await tx
    .select({ releaseId: requirementReleases.releaseId, n: sql<number>`count(*)::int` })
    .from(requirementReleases)
    .innerJoin(requirements, eq(requirements.id, requirementReleases.requirementId))
    .where(and(inArray(requirementReleases.releaseId, ids), isNull(requirements.deletedAt)))
    .groupBy(requirementReleases.releaseId);
  const roles = new Map<string, ProductRole | null>();
  for (const pid of productIds) roles.set(pid, await productRoleOf(tx, actor, pid));
  return rows.map((r) => {
    const o = opts.find((x) => x.id === r.platformOptionId);
    return {
      id: r.id,
      productId: r.productId,
      productKey: prods.find((p) => p.id === r.productId)?.key ?? '',
      versionName: r.versionName,
      platform: o ? { id: o.id, key: o.key, label: o.label, color: o.color } : null,
      iteration: r.iterationId ? (iters.find((i) => i.id === r.iterationId) ?? null) : null,
      status: r.status,
      plannedDate: r.plannedDate,
      baselineDate: r.baselineDate,
      releasedAt: r.releasedAt,
      notes: r.notes,
      requirementCount: counts.find((c) => c.releaseId === r.id)?.n ?? 0,
      canEdit: atLeast(roles.get(r.productId) ?? null, 'editor'),
    };
  });
}

export async function listReleases(db: Db, actor: Actor, input: { productId?: string; iterationId?: string }): Promise<ReleaseView[]> {
  if (!input.productId && !input.iterationId) throw new AppError('invalid', '需要指定产品或迭代');
  return withOrg(db, actor.orgId, async (tx) => {
    const visible = await visibleProductIds(tx, actor);
    if (input.productId && !visible.has(input.productId)) throw new AppError('not_found', '产品不存在');
    if (visible.size === 0) return [];
    const conds: SQL[] = [inArray(releases.productId, [...visible])];
    if (input.productId) conds.push(eq(releases.productId, input.productId));
    if (input.iterationId) conds.push(eq(releases.iterationId, input.iterationId));
    const rows = await tx
      .select()
      .from(releases)
      .where(and(...conds))
      .orderBy(sql`${releases.plannedDate} desc nulls last`, desc(releases.createdAt));
    return views(tx, actor, rows);
  });
}

export async function createRelease(
  db: Db,
  actor: Actor,
  input: { productId: string; versionName: string; platformOptionId?: string | null; iterationId?: string | null; plannedDate: string; notes?: string | null },
): Promise<ReleaseView> {
  const versionName = assertVersionName(input.versionName);
  const plannedDate = assertIsoDate(input.plannedDate, '计划发布日期');
  const notes = assertNotes(input.notes);
  return withOrg(db, actor.orgId, async (tx) => {
    await requireProductRole(tx, actor, input.productId, 'editor');
    if (input.platformOptionId) await assertPlatformOption(tx, input.productId, input.platformOptionId, null);
    if (input.iterationId) await assertReleaseIteration(tx, input.productId, input.iterationId);
    const [row] = await tx
      .insert(releases)
      .values({
        orgId: actor.orgId,
        productId: input.productId,
        versionName,
        platformOptionId: input.platformOptionId ?? null,
        iterationId: input.iterationId ?? null,
        plannedDate,
        baselineDate: plannedDate,
        notes,
      })
      .returning();
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: input.productId,
      type: 'release.created',
      subjectType: 'release',
      subjectId: row!.id,
      actor,
      payload: { versionName, plannedDate },
    });
    const [view] = await views(tx, actor, [row!]);
    return view!;
  });
}

export async function updateRelease(
  db: Db,
  actor: Actor,
  id: string,
  input: { versionName?: string; platformOptionId?: string | null; iterationId?: string | null; plannedDate?: string | null; notes?: string | null },
): Promise<ReleaseView> {
  if (input.plannedDate === null) throw new AppError('invalid', '计划发布日期不能为空');
  const plannedDate = input.plannedDate;
  return withOrg(db, actor.orgId, async (tx) => {
    const cur = await loadRelease(tx, id);
    await requireProductRole(tx, actor, cur.productId, 'editor');
    const next = {
      versionName: input.versionName === undefined ? cur.versionName : assertVersionName(input.versionName),
      platformOptionId: input.platformOptionId === undefined ? cur.platformOptionId : input.platformOptionId,
      iterationId: input.iterationId === undefined ? cur.iterationId : input.iterationId,
      plannedDate: plannedDate === undefined ? cur.plannedDate : assertIsoDate(plannedDate, '计划发布日期'),
      notes: input.notes === undefined ? cur.notes : assertNotes(input.notes),
    };
    if (next.platformOptionId && next.platformOptionId !== cur.platformOptionId) await assertPlatformOption(tx, cur.productId, next.platformOptionId, cur.platformOptionId);
    if (next.iterationId && next.iterationId !== cur.iterationId) await assertReleaseIteration(tx, cur.productId, next.iterationId);
    const changes = (Object.keys(next) as Array<keyof typeof next>)
      .map((field) => ({ field, old: cur[field], new: next[field] }))
      .filter((c) => c.old !== c.new);
    const [row] = await tx.update(releases).set(next).where(eq(releases.id, id)).returning();
    if (changes.length > 0) {
      await recordEvent(tx, { orgId: actor.orgId, productId: cur.productId, type: 'release.updated', subjectType: 'release', subjectId: id, actor, payload: { changes } });
    }
    const [view] = await views(tx, actor, [row!]);
    return view!;
  });
}

export async function markReleaseReleased(db: Db, actor: Actor, id: string): Promise<ReleaseView> {
  return withOrg(db, actor.orgId, async (tx) => {
    const cur = await loadRelease(tx, id);
    await requireProductRole(tx, actor, cur.productId, 'editor');
    if (cur.status === 'released') throw new AppError('invalid', '该版本已发布');
    const now = new Date();
    const [row] = await tx.update(releases).set({ status: 'released', releasedAt: now }).where(eq(releases.id, id)).returning();
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: cur.productId,
      type: 'release.released',
      subjectType: 'release',
      subjectId: id,
      actor,
      payload: { changes: [{ field: 'status', old: cur.status, new: 'released' }] },
    });
    const [view] = await views(tx, actor, [row!]);
    return view!;
  });
}

async function loadPair(tx: Tx, actor: Actor, releaseId: string, requirementId: string) {
  const rel = await loadRelease(tx, releaseId);
  await requireProductRole(tx, actor, rel.productId, 'editor');
  const req = await loadRequirement(tx, requirementId);
  if (req.productId !== rel.productId) throw new AppError('invalid', '只能关联本产品的需求');
  return { rel, req };
}

export async function linkRequirementRelease(db: Db, actor: Actor, releaseId: string, requirementId: string): Promise<void> {
  return withOrg(db, actor.orgId, async (tx) => {
    const { rel, req } = await loadPair(tx, actor, releaseId, requirementId);
    const inserted = await tx
      .insert(requirementReleases)
      .values({ orgId: actor.orgId, requirementId: req.id, releaseId: rel.id })
      .onConflictDoNothing()
      .returning({ releaseId: requirementReleases.releaseId });
    if (inserted.length === 0) return;
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: rel.productId,
      type: 'requirement.release_linked',
      subjectType: 'requirement',
      subjectId: req.id,
      actor,
      payload: { releaseId: rel.id, versionName: rel.versionName },
    });
  });
}

export async function unlinkRequirementRelease(db: Db, actor: Actor, releaseId: string, requirementId: string): Promise<void> {
  return withOrg(db, actor.orgId, async (tx) => {
    const { rel, req } = await loadPair(tx, actor, releaseId, requirementId);
    const deleted = await tx
      .delete(requirementReleases)
      .where(and(eq(requirementReleases.releaseId, rel.id), eq(requirementReleases.requirementId, req.id)))
      .returning({ releaseId: requirementReleases.releaseId });
    if (deleted.length === 0) return;
    await recordEvent(tx, {
      orgId: actor.orgId,
      productId: rel.productId,
      type: 'requirement.release_unlinked',
      subjectType: 'requirement',
      subjectId: req.id,
      actor,
      payload: { releaseId: rel.id, versionName: rel.versionName },
    });
  });
}
