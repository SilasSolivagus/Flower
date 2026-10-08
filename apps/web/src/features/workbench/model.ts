import type { Workbench } from '@/lib/types';

type Org = Workbench['orgs'][number];

export const requirementHref = (org: Pick<Org, 'slug'>, displayKey: string): string => `/${org.slug}/requirements/${displayKey}`;

/** 任务行的链接：挂了需求的去需求详情，否则去所在迭代的甘特页签。 */
export function taskHref(t: Workbench['tasks']['items'][number]): string {
  if (t.requirement) return requirementHref(t.org, t.requirement.displayKey);
  if (t.iteration) return `/${t.org.slug}/iterations/${t.iteration.id}?tab=gantt`;
  return `/${t.org.slug}/iterations`;
}

/** 只有加入了多个组织时才在每行标出组织名。 */
export const showOrgBadge = (orgs: Workbench['orgs']): boolean => orgs.length > 1;

/** 等我签字：需求上的签字去需求详情，PRD 上的签字去 PRD 详情。 */
export function signatureHref(s: Workbench['signatures']['items'][number]): string {
  return s.documentId ? `/${s.org.slug}/documents/${s.displayKey}` : requirementHref(s.org, s.displayKey);
}
