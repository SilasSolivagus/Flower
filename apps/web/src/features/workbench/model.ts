import type { Workbench } from '@/lib/types';

type Org = Workbench['orgs'][number];

export const requirementHref = (org: Pick<Org, 'slug'>, displayKey: string): string => `/${org.slug}/requirements/${displayKey}`;

/** 「我负责的」与「等我跟进」的一行：需求去需求详情，工作项去工作项详情。 */
export function subjectHref(x: { org: Pick<Org, 'slug'>; kind: 'requirement' | 'work_item'; displayKey: string }): string {
  return x.kind === 'work_item' ? `/${x.org.slug}/work-items/${x.displayKey}` : requirementHref(x.org, x.displayKey);
}

/** 任务行的链接：挂了需求的去需求详情，否则去所在迭代的甘特页签。 */
export function taskHref(t: Workbench['tasks']['items'][number]): string {
  if (t.requirement) return requirementHref(t.org, t.requirement.displayKey);
  if (t.iteration) return `/${t.org.slug}/iterations/${t.iteration.id}?tab=gantt`;
  return `/${t.org.slug}/iterations`;
}

/** 只有加入了多个组织时才在每行标出组织名。 */
export const showOrgBadge = (orgs: Workbench['orgs']): boolean => orgs.length > 1;

type Counted = { total: number };

/** 六块都是 0 时工作台全空。有任意一块有数则仍分块列出。 */
export function workbenchIsEmpty(data: {
  owned: Counted;
  following: Counted;
  tasks: Counted;
  signatures: Counted;
  confirmations: Counted;
  unread: Counted;
}): boolean {
  return data.owned.total === 0 && data.following.total === 0 && data.tasks.total === 0 && data.signatures.total === 0 && data.confirmations.total === 0 && data.unread.total === 0;
}

/** 等我确认的检查项：需求上的去需求详情，PRD 上的去 PRD 详情。 */
export function signatureHref(s: Workbench['signatures']['items'][number]): string {
  return s.documentId ? `/${s.org.slug}/documents/${s.displayKey}` : requirementHref(s.org, s.displayKey);
}

/** 等我确认的简报：打开这份简报。 */
export function confirmationHref(c: Workbench['confirmations']['items'][number]): string {
  return `/${c.org.slug}/documents/${c.displayKey}`;
}

/** 工作台某一栏为 0 时，空状态链到当前组织里对应的列表。不新开 /tasks 或 /work-items 列表。 */
export function emptySectionHref(orgSlug: string, section: 'owned' | 'following' | 'tasks' | 'signatures' | 'confirmations' | 'unread'): string {
  switch (section) {
    case 'owned':
      return `/${orgSlug}/requirements`;
    case 'following':
      return `/${orgSlug}/tracking`;
    case 'tasks':
      return `/${orgSlug}/iterations`;
    case 'signatures':
      return `/${orgSlug}/reviews`;
    case 'confirmations':
      return `/${orgSlug}/documents?view=briefs`;
    case 'unread':
      return `/${orgSlug}/notifications`;
  }
}

/** 未读评论：需求去需求详情，PRD 去 PRD 详情（打开即标为已读）。 */
export function unreadHref(u: Workbench['unread']['items'][number]): string {
  return u.documentId ? `/${u.org.slug}/documents/${u.displayKey}` : requirementHref(u.org, u.displayKey);
}

export const iterationHref = (orgSlug: string, id: string): string => `/${orgSlug}/iterations/${id}`;

export const iterationGanttHref = (orgSlug: string, id: string): string => `/${orgSlug}/iterations/${id}?tab=gantt`;

export const iterationsHref = (orgSlug: string): string => `/${orgSlug}/iterations`;

/** 此刻迭代里的任务行：有需求进需求，否则进该迭代甘特。与 taskHref 同一规则。 */
export function nowIterationTaskHref(orgSlug: string, iterationId: string, task: { requirement: { displayKey: string } | null }): string {
  if (task.requirement) return requirementHref({ slug: orgSlug }, task.requirement.displayKey);
  return iterationGanttHref(orgSlug, iterationId);
}

/**
 * 多条此刻迭代默认展开第一条。chosen 为 undefined 表示还没点过；
 * null 表示用户收起了；指向已不在列表里的 id 时回到第一条。
 */
export function openNowIterationId(chosen: string | null | undefined, ids: readonly string[]): string | null {
  const first = ids[0] ?? null;
  if (chosen === undefined) return first;
  if (chosen === null) return null;
  return ids.includes(chosen) ? chosen : first;
}

/** 有此刻迭代时不走空态。没带 org 与「有迭代但不是此刻」用同一句说明。 */
export function nowIterationEmptyKind(presence: Workbench['nowIterationPresence']): 'none' | 'no_now' | null {
  if (presence === 'present') return null;
  if (presence === 'none') return 'none';
  return 'no_now';
}

export function formatIterationRange(start: string, end: string): string {
  return start === end ? start : `${start} 至 ${end}`;
}

export function nowIterationSubtitle(item: { product: { name: string } | null; startDate: string; endDate: string }, statusLabel: string): string {
  return `${item.product?.name ?? '专项'} · ${formatIterationRange(item.startDate, item.endDate)} · ${statusLabel}`;
}
