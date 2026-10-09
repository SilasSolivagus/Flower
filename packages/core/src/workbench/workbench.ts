import { and, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { productRoleOf, visibleProductIds } from '../access/permissions';
import type { Db } from '../db/client';
import { checkItemResults, commentReads, comments, documents, iterations, products, requirements, tasks } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import { documentDisplayKey } from '../documents/markdown';
import type { Actor } from '../domain-types';
import { type StateInfo, stateInfoByProduct, stateOf } from '../iterations/iterations';
import { memberNames, productWorkflowBody } from '../requirements/context';
import { displayKey } from '../requirements/requirements';
import { checkSnapshots, documentSnapshots, signerIdentity, waitingFor } from '../reviews/snapshot';
import { hydrateTasks, orgToday, type TaskStatus } from '../tasks/tasks';
import { listMyOrganizations } from '../tenancy/orgs';

export const WORKBENCH_LIMIT = 100;

export type WorkbenchOrg = { id: string; slug: string; name: string };
export type WorkbenchRequirement = { org: WorkbenchOrg; id: string; displayKey: string; title: string; state: StateInfo; updatedAt: Date };
export type WorkbenchTask = {
  org: WorkbenchOrg;
  id: string;
  displayKey: string;
  title: string;
  requirement: { displayKey: string; title: string } | null;
  iteration: { id: string; name: string } | null;
  status: TaskStatus;
  planStart: string | null;
  progress: number;
};
export type WorkbenchSignature = {
  org: WorkbenchOrg;
  /** 需求上的签字为需求 id，PRD 上的签字为 null。 */
  requirementId: string | null;
  /** PRD 上的签字为 PRD id，需求上的签字为 null。 */
  documentId: string | null;
  displayKey: string;
  title: string;
  itemKey: string;
  itemLabel: string;
  ruleIndex: number;
  /** 可代签时为被代签成员的名字；本人的规则为 null。 */
  onBehalfOf: string | null;
};
export type WorkbenchUnread = {
  org: WorkbenchOrg;
  /** 需求上的未读评论为需求 id，PRD 上的为 null。 */
  requirementId: string | null;
  /** PRD 上的未读评论为 PRD id，需求上的为 null。 */
  documentId: string | null;
  displayKey: string;
  title: string;
  unread: number;
  lastAt: Date;
};
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

type CommentTarget = { type: 'requirement'; table: typeof requirements } | { type: 'document'; table: typeof documents };

/**
 * 一类对象（需求或 PRD）上的未读评论，按对象合计：对象由我负责、或我在上面发过评论；
 * 只计别人发的（作者为空的也计）、我还没读的；已删除的对象与看不到的产品不计。
 */
async function unreadComments(tx: Tx, actor: Actor, visible: string[], { type, table }: CommentTarget) {
  const rows = await tx
    .select({
      targetId: comments.targetId,
      unread: sql<number>`count(*)::int`,
      lastAt: sql`max(${comments.createdAt})`.mapWith(comments.createdAt),
    })
    .from(comments)
    .innerJoin(table, eq(table.id, comments.targetId))
    .where(
      and(
        eq(comments.targetType, type),
        isNull(table.deletedAt),
        inArray(table.productId, visible),
        or(isNull(comments.authorMemberId), ne(comments.authorMemberId, actor.memberId)),
        sql`not exists (select 1 from ${commentReads} where ${commentReads.commentId} = ${comments.id} and ${commentReads.memberId} = ${actor.memberId})`,
        or(
          eq(table.ownerMemberId, actor.memberId),
          sql`exists (select 1 from ${comments} as mine where mine.target_type = ${type} and mine.target_id = ${table.id} and mine.author_member_id = ${actor.memberId})`,
        ),
      ),
    )
    .groupBy(comments.targetId);
  if (rows.length === 0) return [];
  const targets = await tx
    .select({ id: table.id, productId: table.productId, number: table.number, title: table.title })
    .from(table)
    .where(inArray(table.id, rows.map((u) => u.targetId)));
  const byId = new Map(targets.map((x) => [x.id, x]));
  return rows.map((u) => ({ ...byId.get(u.targetId)!, unread: u.unread, lastAt: u.lastAt }));
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

    // 我负责的未完成需求（状态类别按产品工作流判断）
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
      displayKey: v.displayKey,
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
            documentId: null,
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

    // 等我签字（PRD）：评审中的 PRD 上、作用于 PRD 的会签检查项
    const docRows = await tx
      .select()
      .from(documents)
      .where(and(inArray(documents.productId, visible), eq(documents.status, 'review'), isNull(documents.deletedAt)));
    for (const pid of new Set(docRows.map((d) => d.productId))) {
      const body = await productWorkflowBody(tx, pid);
      const items = body.checkItems.filter((c) => c.scope === 'document');
      if (items.length === 0) continue;
      const rows = docRows.filter((d) => d.productId === pid);
      const role = (await productRoleOf(tx, actor, pid))!;
      const who = await signerIdentity(tx, actor, role);
      const snaps = await documentSnapshots(tx, body, rows.map((d) => d.id));
      const signerNames = await memberNames(tx, items.flatMap((c) => (c.signers ?? []).filter((s) => s.by === 'member').map((s) => s.ref)));
      for (const d of rows) {
        for (const w of waitingFor(items, snaps.get(d.id)!, who, role === 'admin', true)) {
          const item = items.find((c) => c.key === w.itemKey)!;
          signatures.push({
            org,
            requirementId: null,
            documentId: d.id,
            displayKey: documentDisplayKey(keyOf.get(pid)!, d.number),
            title: d.title,
            itemKey: w.itemKey,
            itemLabel: item.label,
            ruleIndex: w.ruleIndex,
            onBehalfOf: w.onBehalf ? (signerNames.get(item.signers![w.ruleIndex]!.ref) ?? '已删除的成员') : null,
          });
        }
      }
    }

    // 我负责的、或我评论过的需求与 PRD 上别人发的、我还没读的评论
    const unread: WorkbenchUnread[] = [
      ...(await unreadComments(tx, actor, visible, { type: 'requirement', table: requirements })).map((u) => ({
        org,
        requirementId: u.id,
        documentId: null,
        displayKey: keyFor(u),
        title: u.title,
        unread: u.unread,
        lastAt: u.lastAt,
      })),
      ...(await unreadComments(tx, actor, visible, { type: 'document', table: documents })).map((u) => ({
        org,
        requirementId: null,
        documentId: u.id,
        displayKey: documentDisplayKey(keyOf.get(u.productId)!, u.number),
        title: u.title,
        unread: u.unread,
        lastAt: u.lastAt,
      })),
    ];

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
