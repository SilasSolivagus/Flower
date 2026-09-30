import { and, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { productRoleOf, visibleProductIds } from '../access/permissions';
import type { Db } from '../db/client';
import { checkItemResults, commentReads, comments, iterations, products, requirements, tasks } from '../db/schema';
import { withOrg } from '../db/tx';
import type { Actor } from '../domain-types';
import { type StateInfo, stateInfoByProduct, stateOf } from '../iterations/iterations';
import { memberNames, productWorkflowBody } from '../requirements/context';
import { displayKey } from '../requirements/requirements';
import { checkSnapshots, signerIdentity, waitingFor } from '../reviews/snapshot';
import { hydrateTasks, orgToday, type TaskStatus } from '../tasks/tasks';
import { listMyOrganizations } from '../tenancy/orgs';

export const WORKBENCH_LIMIT = 100;

export type WorkbenchOrg = { id: string; slug: string; name: string };
export type WorkbenchRequirement = { org: WorkbenchOrg; id: string; displayKey: string; title: string; state: StateInfo; updatedAt: Date };
export type WorkbenchTask = {
  org: WorkbenchOrg;
  id: string;
  title: string;
  requirement: { displayKey: string; title: string } | null;
  iteration: { id: string; name: string } | null;
  status: TaskStatus;
  planStart: string | null;
  progress: number;
};
export type WorkbenchSignature = {
  org: WorkbenchOrg;
  requirementId: string;
  displayKey: string;
  title: string;
  itemKey: string;
  itemLabel: string;
  ruleIndex: number;
  /** 可代签时为被代签成员的名字；本人的规则为 null。 */
  onBehalfOf: string | null;
};
export type WorkbenchUnread = { org: WorkbenchOrg; requirementId: string; displayKey: string; title: string; unread: number; lastAt: Date };
export type WorkbenchSection<T> = { total: number; items: T[] };
export type Workbench = {
  orgs: WorkbenchOrg[];
  owned: WorkbenchSection<WorkbenchRequirement>;
  tasks: WorkbenchSection<WorkbenchTask>;
  signatures: WorkbenchSection<WorkbenchSignature>;
  unread: WorkbenchSection<WorkbenchUnread>;
};
type OrgPart = { owned: WorkbenchRequirement[]; tasks: WorkbenchTask[]; signatures: WorkbenchSignature[]; unread: WorkbenchUnread[] };

function section<T>(list: T[], compare: (a: T, b: T) => number): WorkbenchSection<T> {
  return { total: list.length, items: [...list].sort(compare).slice(0, WORKBENCH_LIMIT) };
}

/** 一个组织内的工作台数据：在该组织的 withOrg 事务里、以该组织的成员身份读取。 */
async function orgPart(db: Db, actor: Actor, org: WorkbenchOrg, today: string | undefined): Promise<OrgPart> {
  return withOrg(db, actor.orgId, async (tx) => {
    const visible = [...(await visibleProductIds(tx, actor))];
    if (visible.length === 0) return { owned: [], tasks: [], signatures: [], unread: [] };
    const day = today ?? (await orgToday(tx, actor.orgId));
    const prods = await tx.select({ id: products.id, key: products.key }).from(products).where(inArray(products.id, visible));
    const keyOf = new Map(prods.map((p) => [p.id, p.key]));
    const keyFor = (r: { productId: string; number: number }) => displayKey(keyOf.get(r.productId)!, r.number);
    const info = await stateInfoByProduct(tx, visible);
    const isOpen = (r: { productId: string; stateKey: string }) => {
      const category = stateOf(info, r.productId, r.stateKey).category;
      return category !== 'completed' && category !== 'canceled';
    };

    // 我负责的需求（全部读出：未读评论也要用到已完成的需求）
    const ownedRows = await tx
      .select()
      .from(requirements)
      .where(and(eq(requirements.ownerMemberId, actor.memberId), isNull(requirements.deletedAt), inArray(requirements.productId, visible)));
    const owned = ownedRows
      .filter(isOpen)
      .map((r) => ({ org, id: r.id, displayKey: keyFor(r), title: r.title, state: stateOf(info, r.productId, r.stateKey), updatedAt: r.updatedAt }));

    // 指派给我的未完成任务，排除已取消或已删除迭代里的
    const taskRows = await tx
      .select({ t: tasks, it: { id: iterations.id, name: iterations.name } })
      .from(tasks)
      .leftJoin(iterations, eq(iterations.id, tasks.iterationId))
      .where(
        and(
          eq(tasks.assigneeMemberId, actor.memberId),
          ne(tasks.status, 'done'),
          inArray(tasks.productId, visible),
          or(isNull(tasks.iterationId), and(isNull(iterations.deletedAt), ne(iterations.status, 'canceled'))),
        ),
      );
    const taskViews = await hydrateTasks(tx, actor, taskRows.map((r) => r.t), day);
    const myTasks = taskViews.map((v, i) => ({
      org,
      id: v.id,
      title: v.title,
      requirement: v.requirement ? { displayKey: v.requirement.displayKey, title: v.requirement.title } : null,
      iteration: taskRows[i]!.it,
      status: v.status,
      planStart: v.planStart,
      progress: v.progress,
    }));

    // 等我签字：只看有检查项记录（评审可能已开始）的未完成需求
    const candidates = await tx
      .select()
      .from(requirements)
      .where(
        and(
          inArray(requirements.productId, visible),
          isNull(requirements.deletedAt),
          sql`exists (select 1 from ${checkItemResults} where ${checkItemResults.targetType} = 'requirement' and ${checkItemResults.targetId} = ${requirements.id})`,
        ),
      );
    const signatures: WorkbenchSignature[] = [];
    for (const pid of new Set(candidates.map((r) => r.productId))) {
      const rows = candidates.filter((r) => r.productId === pid && isOpen(r));
      if (rows.length === 0) continue;
      const body = await productWorkflowBody(tx, pid);
      const items = body.checkItems.filter((c) => c.scope === 'requirement');
      const role = (await productRoleOf(tx, actor, pid))!;
      const who = await signerIdentity(tx, actor, role);
      const snaps = await checkSnapshots(tx, body, rows.map((r) => r.id));
      const signerNames = await memberNames(
        tx,
        items.flatMap((c) => (c.signers ?? []).filter((s) => s.by === 'member').map((s) => s.ref)),
      );
      for (const r of rows) {
        const snap = snaps.get(r.id)!;
        for (const w of waitingFor(items, snap, who, role === 'admin')) {
          const item = items.find((c) => c.key === w.itemKey)!;
          signatures.push({
            org,
            requirementId: r.id,
            displayKey: keyFor(r),
            title: r.title,
            itemKey: w.itemKey,
            itemLabel: item.label,
            ruleIndex: w.ruleIndex,
            onBehalfOf: w.onBehalf ? (signerNames.get(item.signers![w.ruleIndex]!.ref) ?? '已删除的成员') : null,
          });
        }
      }
    }

    // 我负责的需求上别人发的、我还没读的评论
    const unreadRows = await tx
      .select({
        requirementId: comments.targetId,
        unread: sql<number>`count(*)::int`,
        lastAt: sql`max(${comments.createdAt})`.mapWith(comments.createdAt),
      })
      .from(comments)
      .innerJoin(requirements, eq(requirements.id, comments.targetId))
      .where(
        and(
          eq(comments.targetType, 'requirement'),
          eq(requirements.ownerMemberId, actor.memberId),
          isNull(requirements.deletedAt),
          inArray(requirements.productId, visible),
          or(isNull(comments.authorMemberId), ne(comments.authorMemberId, actor.memberId)),
          sql`not exists (select 1 from ${commentReads} where ${commentReads.commentId} = ${comments.id} and ${commentReads.memberId} = ${actor.memberId})`,
        ),
      )
      .groupBy(comments.targetId);
    const ownedById = new Map(ownedRows.map((r) => [r.id, r]));
    const unread = unreadRows.map((u) => {
      const r = ownedById.get(u.requirementId)!;
      return { org, requirementId: r.id, displayKey: keyFor(r), title: r.title, unread: u.unread, lastAt: u.lastAt };
    });

    return { owned, tasks: myTasks, signatures, unread };
  });
}

/**
 * 跨组织工作台。成员关系查找走 withSystem（listMyOrganizations，CLAUDE.md 允许的场景）；
 * 每个组织的数据各自在一个 withOrg 事务里、以该组织的成员身份读取，不在同一个 RLS 上下文里混读多个组织。
 */
export async function getWorkbench(db: Db, accountId: string, opts: { today?: string } = {}): Promise<Workbench> {
  const memberships = await listMyOrganizations(db, accountId);
  const orgs = memberships.map((m) => ({ id: m.id, slug: m.slug, name: m.name }));
  const parts: OrgPart[] = [];
  for (const [i, m] of memberships.entries()) {
    const actor: Actor = { accountId, memberId: m.memberId, orgId: m.id, orgRole: m.role, tokenId: null, tokenScope: null };
    parts.push(await orgPart(db, actor, orgs[i]!, opts.today));
  }
  return {
    orgs,
    owned: section(parts.flatMap((p) => p.owned), (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()),
    tasks: section(parts.flatMap((p) => p.tasks), (a, b) => (a.planStart ?? '9999-12-31').localeCompare(b.planStart ?? '9999-12-31')),
    signatures: section(parts.flatMap((p) => p.signatures), (a, b) => a.displayKey.localeCompare(b.displayKey, 'zh-CN', { numeric: true })),
    unread: section(parts.flatMap((p) => p.unread), (a, b) => b.lastAt.getTime() - a.lastAt.getTime()),
  };
}
