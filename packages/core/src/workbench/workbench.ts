import { and, eq, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import { productRoleOf, visibleProductIds } from '../access/permissions';
import type { Db } from '../db/client';
import { checkItemResults, commentReads, comments, documentBriefs, documents, iterations, products, progressUpdates, requirements, tasks, workItems } from '../db/schema';
import { type Tx, withOrg } from '../db/tx';
import { briefDisplayKey, documentDisplayKey, documentKeyOf } from '../documents/markdown';
import type { Actor } from '../domain-types';
import { type StateInfo, stateInfoByProduct, stateOf } from '../iterations/iterations';
import { workItemDisplayKey } from '../links/syntax';
import { memberNames, productWorkflowBody } from '../requirements/context';
import { displayKey } from '../requirements/requirements';
import { checkSnapshots, documentSnapshots, signerIdentity, waitingFor } from '../reviews/snapshot';
import { hydrateTasks, orgToday, type TaskStatus } from '../tasks/tasks';
import { listMyOrganizations } from '../tenancy/orgs';
import { canViewUnlinked } from '../tracking/access';
import { latestProgressTx } from '../tracking/tracking';

export const WORKBENCH_LIMIT = 100;

/** 工作项在「我负责的」里显示的状态（只列进行中的）。 */
const WORK_ITEM_STATE: StateInfo = { label: '进行中', color: '#f59e0b', category: 'started' };

export type WorkbenchOrg = { id: string; slug: string; name: string };
/** 「我负责的」一行：需求或进行中的工作项（P3-C1）。 */
export type WorkbenchRequirement = { org: WorkbenchOrg; kind: 'requirement' | 'work_item'; id: string; displayKey: string; title: string; state: StateInfo; updatedAt: Date };
/** 「等我跟进」一行：我是最新一条进展记录的跟进人。at 为该进展的时间。 */
export type WorkbenchFollowUp = { org: WorkbenchOrg; kind: 'requirement' | 'work_item'; id: string; displayKey: string; title: string; nextStep: string | null; at: Date };
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
/** 「等我确认」一行：我是确认人、且简报仍在讨论中或可以写 PRD。 */
export type WorkbenchConfirmation = {
  org: WorkbenchOrg;
  documentId: string;
  displayKey: string;
  title: string;
  status: 'discussing' | 'ready';
  updatedAt: Date;
};
export type WorkbenchSection<T> = { total: number; items: T[] };
export type Workbench = {
  orgs: WorkbenchOrg[];
  owned: WorkbenchSection<WorkbenchRequirement>;
  tasks: WorkbenchSection<WorkbenchTask>;
  signatures: WorkbenchSection<WorkbenchSignature>;
  unread: WorkbenchSection<WorkbenchUnread>;
  following: WorkbenchSection<WorkbenchFollowUp>;
  confirmations: WorkbenchSection<WorkbenchConfirmation>;
};
type OrgPart = {
  owned: WorkbenchRequirement[];
  tasks: WorkbenchTask[];
  signatures: WorkbenchSignature[];
  unread: WorkbenchUnread[];
  following: WorkbenchFollowUp[];
  confirmations: WorkbenchConfirmation[];
};

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
    const unlinked = canViewUnlinked(actor);
    if (visible.length === 0 && !unlinked) return { owned: [], tasks: [], signatures: [], unread: [], following: [], confirmations: [] };
    const day = today ?? (await orgToday(tx, actor.orgId));
    const prods = await tx.select({ id: products.id, key: products.key }).from(products).where(inArray(products.id, visible));
    const keyOf = new Map(prods.map((p) => [p.id, p.key]));
    const keyFor = (r: { productId: string; number: number }) => displayKey(keyOf.get(r.productId)!, r.number);
    const info = await stateInfoByProduct(tx, visible);
    const isOpen = (r: { productId: string; stateKey: string }) => {
      const category = stateOf(info, r.productId, r.stateKey).category;
      return category !== 'completed' && category !== 'canceled';
    };

    // 我负责的未完成需求（状态类别按产品工作流判断）与进行中的工作项（关联产品时须能看到该产品）
    const ownedRows = await tx
      .select()
      .from(requirements)
      .where(and(eq(requirements.ownerMemberId, actor.memberId), isNull(requirements.deletedAt), inArray(requirements.productId, visible)));
    const workScope = or(inArray(workItems.productId, visible), unlinked ? isNull(workItems.productId) : sql`false`);
    const myWork = await tx
      .select()
      .from(workItems)
      .where(and(eq(workItems.ownerMemberId, actor.memberId), eq(workItems.status, 'active'), isNull(workItems.deletedAt), workScope));
    const owned: WorkbenchRequirement[] = [
      ...ownedRows
        .filter(isOpen)
        .map((r) => ({ org, kind: 'requirement' as const, id: r.id, displayKey: keyFor(r), title: r.title, state: stateOf(info, r.productId, r.stateKey), updatedAt: r.updatedAt })),
      ...myWork.map((w) => ({ org, kind: 'work_item' as const, id: w.id, displayKey: workItemDisplayKey(w.number), title: w.title, state: WORK_ITEM_STATE, updatedAt: w.updatedAt })),
    ];

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

    // 我负责的、或我评论过的需求与 PRD 上别人发的、我还没读的评论（简报也算文档，编号按类型显示）
    const docUnread = await unreadComments(tx, actor, visible, { type: 'document', table: documents });
    const docKinds = docUnread.length > 0 ? await tx.select({ id: documents.id, kind: documents.kind }).from(documents).where(inArray(documents.id, docUnread.map((u) => u.id))) : [];
    const kindOf = new Map(docKinds.map((d) => [d.id, d.kind]));
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
      ...docUnread.map((u) => ({
        org,
        requirementId: null,
        documentId: u.id,
        displayKey: documentKeyOf(kindOf.get(u.id)!, keyOf.get(u.productId)!, u.number),
        title: u.title,
        unread: u.unread,
        lastAt: u.lastAt,
      })),
    ];

    // 等我跟进：每个对象最新一条未删除的进展，跟进人是我，且对象仍在跟进中（需求跟进中、工作项进行中）
    const mine = await tx
      .selectDistinct({ requirementId: progressUpdates.requirementId, workItemId: progressUpdates.workItemId })
      .from(progressUpdates)
      .where(and(eq(progressUpdates.followerMemberId, actor.memberId), isNull(progressUpdates.deletedAt)));
    const mineReq = mine.flatMap((m) => (m.requirementId ? [m.requirementId] : []));
    const mineWork = mine.flatMap((m) => (m.workItemId ? [m.workItemId] : []));
    const latest = await latestProgressTx(tx, mineReq, mineWork);
    const mineLatest = (ids: string[]) => ids.flatMap((id) => (latest.get(id)?.followerMemberId === actor.memberId ? [latest.get(id)!] : []));
    const following: WorkbenchFollowUp[] = [];
    const reqLatest = mineLatest(mineReq);
    if (reqLatest.length) {
      const rows = await tx
        .select()
        .from(requirements)
        .where(and(inArray(requirements.id, reqLatest.map((p) => p.requirementId!)), isNull(requirements.deletedAt), inArray(requirements.productId, visible), isNotNull(requirements.trackedSince)));
      const byId = new Map(rows.map((r) => [r.id, r]));
      for (const p of reqLatest) {
        const r = byId.get(p.requirementId!);
        if (r && isOpen(r)) following.push({ org, kind: 'requirement', id: r.id, displayKey: keyFor(r), title: r.title, nextStep: p.nextStep, at: p.createdAt });
      }
    }
    const workLatest = mineLatest(mineWork);
    if (workLatest.length) {
      const rows = await tx
        .select()
        .from(workItems)
        .where(and(inArray(workItems.id, workLatest.map((p) => p.workItemId!)), isNull(workItems.deletedAt), eq(workItems.status, 'active'), workScope));
      const byId = new Map(rows.map((w) => [w.id, w]));
      for (const p of workLatest) {
        const w = byId.get(p.workItemId!);
        if (w) following.push({ org, kind: 'work_item', id: w.id, displayKey: workItemDisplayKey(w.number), title: w.title, nextStep: p.nextStep, at: p.createdAt });
      }
    }

    // 等我确认：我是确认人，且简报还在讨论中或可以写 PRD（已转 PRD、已废弃不计入）
    const confirmations: WorkbenchConfirmation[] = [];
    if (visible.length > 0) {
      const briefRows = await tx
        .select({
          id: documents.id,
          number: documents.number,
          title: documents.title,
          status: documents.status,
          updatedAt: documents.updatedAt,
          productKey: products.key,
        })
        .from(documentBriefs)
        .innerJoin(documents, eq(documents.id, documentBriefs.documentId))
        .innerJoin(products, eq(products.id, documents.productId))
        .where(
          and(
            eq(documentBriefs.deciderMemberId, actor.memberId),
            eq(documents.kind, 'brief'),
            inArray(documents.status, ['discussing', 'ready']),
            isNull(documents.deletedAt),
            inArray(documents.productId, visible),
          ),
        );
      for (const row of briefRows) {
        confirmations.push({
          org,
          documentId: row.id,
          displayKey: briefDisplayKey(row.productKey, row.number),
          title: row.title,
          status: row.status === 'ready' ? 'ready' : 'discussing',
          updatedAt: row.updatedAt,
        });
      }
    }

    return { owned, tasks: myTasks, signatures, unread, following, confirmations };
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
    following: section(parts.flatMap((p) => p.following), (a, b) => a.at.getTime() - b.at.getTime()),
    confirmations: section(
      parts.flatMap((p) => p.confirmations),
      (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || a.displayKey.localeCompare(b.displayKey, 'zh-CN', { numeric: true }),
    ),
  };
}
