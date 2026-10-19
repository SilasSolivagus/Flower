import { and, eq, isNull } from 'drizzle-orm';
import { baseProductRole } from '../access/permissions';
import {
  comments,
  documents,
  domainEvents,
  functionTags,
  memberFunctionTags,
  members,
  productMembers,
  products,
  progressUpdates,
  requirements,
  subscriptions,
  tasks,
  workItems,
} from '../db/schema';
import type { Tx } from '../db/tx';
import type { DocumentKind, DocumentStatus } from '../documents/constants';
import { DOCUMENT_STATUS_LABELS, documentKeyOf } from '../documents/markdown';
import { plainMentions, taskDisplayKey, workItemDisplayKey } from '../links/syntax';
import { MEMBER_NOTIFICATION_RANK, type MemberNotificationKind, type NotificationSubjectType } from '../notifications/constants';
import { productWorkflowBody } from '../requirements/context';
import type { CheckState } from '../requirements/labels';
import { displayKey } from '../requirements/requirements';
import { type CheckItem, reviewStarted } from '../requirements/workflow-runtime';
import { checkSnapshots, documentSnapshots, waitingFor } from '../reviews/snapshot';

export type EventRow = typeof domainEvents.$inferSelect;
/** productId 为空：不关联产品的工作项（收件人排除访客）。documentKind：文档对象的类型（简报的文案写「简报」）。 */
export type NotificationSubject = { type: NotificationSubjectType; id: string; productId: string | null; title: string; url: string; documentKind?: DocumentKind };
export type Candidate = { memberId: string; kind: MemberNotificationKind; body: string };
export type EventPlan = { subject: NotificationSubject; candidates: Candidate[]; autoSubscribe: string[] };
type Change = { field: string; old: unknown; new: unknown };

/** 会生成站内通知的事件；其余事件（含 legacy.*）不处理。 */
export const HANDLED_EVENT_TYPES: ReadonlySet<string> = new Set([
  'comment.created',
  'requirement.created',
  'requirement.updated',
  'requirement.assignment_added',
  'requirement.state_changed',
  'requirement.field_changed',
  'requirement.iteration_changed',
  'document.created',
  'document.updated',
  'document.saved',
  'document.status_changed',
  'brief.updated',
  'check_item.updated',
  'check_item.signed',
  'task.created',
  'task.updated',
  'work_item.created',
  'work_item.updated',
  'progress.created',
  'progress.updated',
]);

const TITLE_MAX = 120;
const EXCERPT_MAX = 60;
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);
const changeOf = (payload: Record<string, unknown>, field: string): Change | undefined =>
  (Array.isArray(payload.changes) ? (payload.changes as Change[]) : []).find((c) => c.field === field);
const idList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : []);
const asId = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
/** 变化前后的值：数组用顿号连接，空值为「空」。 */
const shown = (v: unknown): string => (Array.isArray(v) ? (v.length ? v.join('、') : '空') : v === null || v === undefined || v === '' ? '空' : String(v));
/** 进展记录指定跟进人时的说明：有下一步时带上下一步。 */
const followerBody = (nextStep: string | null): string => (nextStep ? `你是下一步跟进人：${clip(nextStep, EXCERPT_MAX)}` : '你是下一步跟进人');

/** 每人只取排名最高的一种（同一种以先出现的为准）；操作人本人不通知。 */
export function pickRecipients(candidates: Candidate[], actorMemberId: string | null): Map<string, Candidate> {
  const out = new Map<string, Candidate>();
  for (const c of candidates) {
    if (c.memberId === actorMemberId) continue;
    const cur = out.get(c.memberId);
    if (!cur || MEMBER_NOTIFICATION_RANK[c.kind] > MEMBER_NOTIFICATION_RANK[cur.kind]) out.set(c.memberId, c);
  }
  return out;
}

/** 需求的评审是否由这次检查项变化开始：变化后已开始，换回变化前的状态则未开始。 */
export function reviewJustStarted(items: CheckItem[], states: Record<string, CheckState>, itemKey: string, old: CheckState): boolean {
  return reviewStarted(items, states) && !reviewStarted(items, { ...states, [itemKey]: old });
}

/** 通知指向的对象：「编号 标题」与站内路径；对象或所在产品已删除时为 null。 */
export async function subjectTx(tx: Tx, slug: string, type: string, id: string): Promise<NotificationSubject | null> {
  if (type === 'requirement') {
    const [r] = await tx
      .select({ productId: requirements.productId, number: requirements.number, title: requirements.title, key: products.key })
      .from(requirements)
      .innerJoin(products, eq(products.id, requirements.productId))
      .where(and(eq(requirements.id, id), isNull(requirements.deletedAt), isNull(products.deletedAt)));
    if (!r) return null;
    const k = displayKey(r.key, r.number);
    return { type: 'requirement', id, productId: r.productId, title: clip(`${k} ${r.title}`, TITLE_MAX), url: `/${slug}/requirements/${k}` };
  }
  if (type === 'document') {
    const [d] = await tx
      .select({ productId: documents.productId, number: documents.number, title: documents.title, kind: documents.kind, key: products.key })
      .from(documents)
      .innerJoin(products, eq(products.id, documents.productId))
      .where(and(eq(documents.id, id), isNull(documents.deletedAt), isNull(products.deletedAt)));
    if (!d) return null;
    const k = documentKeyOf(d.kind, d.key, d.number);
    return { type: 'document', id, productId: d.productId, title: clip(`${k} ${d.title}`, TITLE_MAX), url: `/${slug}/documents/${k}`, documentKind: d.kind };
  }
  if (type === 'task') {
    const [x] = await tx
      .select({ productId: tasks.productId, number: tasks.number, title: tasks.title, key: products.key })
      .from(tasks)
      .innerJoin(products, eq(products.id, tasks.productId))
      .where(and(eq(tasks.id, id), isNull(products.deletedAt)));
    if (!x) return null;
    const k = taskDisplayKey(x.key, x.number);
    return { type: 'task', id, productId: x.productId, title: clip(`${k} ${x.title}`, TITLE_MAX), url: `/${slug}/tasks/${k}` };
  }
  if (type === 'work_item') {
    const [w] = await tx
      .select({ productId: workItems.productId, number: workItems.number, title: workItems.title, productDeletedAt: products.deletedAt })
      .from(workItems)
      .leftJoin(products, eq(products.id, workItems.productId))
      .where(and(eq(workItems.id, id), isNull(workItems.deletedAt)));
    if (!w || w.productDeletedAt) return null;
    const k = workItemDisplayKey(w.number);
    return { type: 'work_item', id, productId: w.productId, title: clip(`${k} ${w.title}`, TITLE_MAX), url: `/${slug}/work-items/${k}` };
  }
  return null;
}

/** 未取消关注的关注者（需求、PRD 与工作项可以关注）。 */
async function followersTx(tx: Tx, subject: NotificationSubject): Promise<string[]> {
  if (subject.type !== 'requirement' && subject.type !== 'document' && subject.type !== 'work_item') return [];
  const rows = await tx
    .select({ memberId: subscriptions.memberId })
    .from(subscriptions)
    .where(and(eq(subscriptions.subjectType, subject.type), eq(subscriptions.subjectId, subject.id), isNull(subscriptions.mutedAt)));
  return rows.map((r) => r.memberId);
}

/** 等这个需求或 PRD 签字的成员：与工作台同一个 waitingFor，只取本人规则（不含代签）。PRD 只在进入评审时调用。 */
async function signersTx(tx: Tx, subject: NotificationSubject): Promise<Candidate[]> {
  // 只用于需求与 PRD，二者总属于某个产品
  const productId = subject.productId!;
  const body = await productWorkflowBody(tx, productId);
  const scope = subject.type === 'requirement' ? 'requirement' : 'document';
  const items = body.checkItems.filter((c) => c.scope === scope);
  if (!items.some((c) => c.type === 'signoff')) return [];
  const snap =
    subject.type === 'requirement' ? (await checkSnapshots(tx, body, [subject.id])).get(subject.id)! : (await documentSnapshots(tx, body, [subject.id])).get(subject.id)!;
  const people = await tx
    .select({ id: members.id, orgRole: members.orgRole })
    .from(members)
    .where(and(eq(members.status, 'active'), eq(members.kind, 'human')));
  const tags = await tx.select({ memberId: memberFunctionTags.memberId, tagId: memberFunctionTags.tagId }).from(memberFunctionTags);
  const roles = await tx.select({ memberId: productMembers.memberId, role: productMembers.role }).from(productMembers).where(eq(productMembers.productId, productId));
  const roleOf = new Map(roles.map((r) => [r.memberId, r.role]));
  const out: Candidate[] = [];
  for (const p of people) {
    const productRole = baseProductRole(p.orgRole, roleOf.get(p.id) ?? null);
    if (!productRole) continue;
    const who = { memberId: p.id, functionTagIds: tags.filter((x) => x.memberId === p.id).map((x) => x.tagId), productRole };
    const waiting = waitingFor(items, snap, who, false, subject.type === 'document' ? true : undefined).filter((w) => !w.onBehalf);
    if (waiting.length === 0) continue;
    const labels = [...new Set(waiting.map((w) => items.find((c) => c.key === w.itemKey)!.label))];
    out.push({ memberId: p.id, kind: 'signoff_due', body: `「${labels.join('」「')}」等你签字` });
  }
  return out;
}

/** 一条事件要通知谁、说什么、给谁补自动关注；不生成通知的事件与对象已删除的事件返回 null。 */
export async function planEventTx(tx: Tx, ev: EventRow, slug: string): Promise<EventPlan | null> {
  if (!HANDLED_EVENT_TYPES.has(ev.type)) return null;
  const subject = await subjectTx(tx, slug, ev.subjectType, ev.subjectId);
  if (!subject) return null;
  const p = ev.payload;
  const candidates: Candidate[] = [];
  const autoSubscribe: string[] = [];
  const add = (ids: Array<string | null>, kind: MemberNotificationKind, body: string) => {
    for (const id of ids) if (id) candidates.push({ memberId: id, kind, body });
  };
  const assign = (id: string | null, body: string) => {
    add([id], 'assigned', body);
    if (id) autoSubscribe.push(id);
  };
  const mention = (ids: string[], body: string) => {
    add(ids, 'mentioned', body);
    autoSubscribe.push(...ids);
  };
  const notifyFollowers = async (body: string) => add(await followersTx(tx, subject), 'followed_change', body);
  const isBrief = subject.documentKind === 'brief';

  switch (ev.type) {
    case 'comment.created': {
      mention(idList(p.mentionedMemberIds), '在评论中 @ 了你');
      if (ev.actorMemberId) autoSubscribe.push(ev.actorMemberId);
      const commentId = asId(p.commentId);
      const [c] = commentId ? await tx.select({ body: comments.body }).from(comments).where(eq(comments.id, commentId)) : [];
      await notifyFollowers(`发表了评论：${clip(plainMentions(c?.body ?? '').replace(/\s+/g, ' ').trim(), EXCERPT_MAX)}`);
      break;
    }
    case 'requirement.created':
      assign(asId(p.ownerMemberId), '把你设为需求负责人');
      mention(idList(p.mentionedMemberIds), '在需求描述中 @ 了你');
      break;
    case 'requirement.updated':
      assign(asId(changeOf(p, 'ownerMemberId')?.new), '把你设为需求负责人');
      mention(idList(p.mentionedMemberIds), '在需求描述中 @ 了你');
      break;
    case 'requirement.assignment_added': {
      const a = changeOf(p, 'assignments')?.new as { memberId?: unknown; functionTagId?: unknown } | null | undefined;
      const tagId = asId(a?.functionTagId);
      const [tag] = tagId ? await tx.select({ name: functionTags.name }).from(functionTags).where(eq(functionTags.id, tagId)) : [];
      assign(asId(a?.memberId), tag ? `把你分配为「${tag.name}」` : '把你分配到这条需求');
      break;
    }
    case 'requirement.state_changed': {
      const ch = changeOf(p, 'stateKey');
      const wf = await productWorkflowBody(tx, subject.productId!);
      const name = (k: unknown) => wf.states.find((s) => s.key === k)?.label ?? shown(k);
      await notifyFollowers(`把状态从「${name(ch?.old)}」改为「${name(ch?.new)}」`);
      break;
    }
    case 'requirement.field_changed': {
      const ch = changeOf(p, 'priority');
      if (ch) await notifyFollowers(`把优先级从「${shown(ch.old)}」改为「${shown(ch.new)}」`);
      break;
    }
    case 'requirement.iteration_changed':
      await notifyFollowers(
        asId(changeOf(p, 'iterationId')?.new) ? `把迭代改为「${typeof p.iterationName === 'string' ? p.iterationName : '未命名迭代'}」` : '把需求移出了迭代',
      );
      break;
    case 'document.created':
      assign(asId(p.ownerMemberId), '把你设为 PRD 负责人');
      break;
    case 'document.updated':
      assign(asId(changeOf(p, 'ownerMemberId')?.new), '把你设为 PRD 负责人');
      break;
    case 'document.saved':
      mention(idList(p.mentionedMemberIds), isBrief ? '在简报正文中 @ 了你' : '在 PRD 正文中 @ 了你');
      break;
    case 'document.status_changed': {
      const ch = changeOf(p, 'status');
      const name = (s: unknown) => DOCUMENT_STATUS_LABELS[s as DocumentStatus] ?? shown(s);
      await notifyFollowers(`${isBrief ? '把简报状态' : '把 PRD 状态'}从「${name(ch?.old)}」改为「${name(ch?.new)}」`);
      if (ch?.new === 'review') candidates.push(...(await signersTx(tx, subject)));
      break;
    }
    case 'brief.updated':
      assign(asId(changeOf(p, 'deciderMemberId')?.new), '把你设为这份简报的确认人，请确认问题、规则、指标与上线策略');
      break;
    case 'check_item.updated':
    case 'check_item.signed': {
      const ch = changeOf(p, 'state');
      const itemKey = typeof p.itemKey === 'string' ? p.itemKey : null;
      if (subject.type !== 'requirement' || !ch || !itemKey) break;
      const wf = await productWorkflowBody(tx, subject.productId!);
      const items = wf.checkItems.filter((c) => c.scope === 'requirement');
      const snap = (await checkSnapshots(tx, wf, [subject.id])).get(subject.id)!;
      if (reviewJustStarted(items, snap.states, itemKey, ch.old as CheckState)) candidates.push(...(await signersTx(tx, subject)));
      break;
    }
    case 'task.created':
      add([asId(p.assigneeMemberId)], 'assigned', '把任务指派给你');
      break;
    case 'task.updated':
      add([asId(changeOf(p, 'assigneeMemberId')?.new)], 'assigned', '把任务指派给你');
      break;
    case 'work_item.created':
      assign(asId(p.ownerMemberId), '把工作项指派给你');
      mention(idList(p.mentionedMemberIds), '在工作项描述中 @ 了你');
      break;
    case 'work_item.updated':
      assign(asId(changeOf(p, 'ownerMemberId')?.new), '把工作项指派给你');
      mention(idList(p.mentionedMemberIds), '在工作项描述中 @ 了你');
      break;
    case 'progress.created': {
      const progressId = asId(p.progressId);
      const [row] = progressId
        ? await tx.select({ body: progressUpdates.body, nextStep: progressUpdates.nextStep }).from(progressUpdates).where(eq(progressUpdates.id, progressId))
        : [];
      add([asId(p.followerMemberId)], 'assigned', followerBody(row?.nextStep ?? null));
      await notifyFollowers(`写了进展：${clip(plainMentions(row?.body ?? '').replace(/\s+/g, ' ').trim(), EXCERPT_MAX)}`);
      break;
    }
    case 'progress.updated': {
      const ch = changeOf(p, 'followerMemberId');
      if (!ch) break;
      const progressId = asId(p.progressId);
      const [row] = progressId ? await tx.select({ nextStep: progressUpdates.nextStep }).from(progressUpdates).where(eq(progressUpdates.id, progressId)) : [];
      add([asId(ch.new)], 'assigned', followerBody(row?.nextStep ?? null));
      break;
    }
  }
  return { subject, candidates, autoSubscribe };
}
