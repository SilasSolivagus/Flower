import type { OrgRole } from '@/lib/types';

export type NavIcon = 'home' | 'grid' | 'list' | 'cycle' | 'review' | 'doc' | 'users' | 'tag' | 'box' | 'flow' | 'sliders' | 'bot' | 'building' | 'bell';
export type NavItem = { key: string; label: string; href?: string; icon: NavIcon };

export const isOrgAdminRole = (role: OrgRole): boolean => role === 'owner' || role === 'admin';

const SETTINGS: Array<[string, string, NavIcon]> = [
  ['members', '成员', 'users'],
  ['tags', '职能标签', 'tag'],
  ['products', '产品', 'box'],
  ['workflows', '流程模板', 'flow'],
  ['fields', '字段字典', 'sliders'],
  ['templates', '文档模板', 'doc'],
  ['agents', 'Agent 与 Token', 'bot'],
  ['notifications', '推送', 'bell'],
  ['general', '组织信息', 'building'],
];

export function buildNav(org: string, orgRole: OrgRole): { main: NavItem[]; settings: NavItem[] } {
  return {
    main: [
      { key: 'home', label: '工作台', href: `/${org}`, icon: 'home' },
      { key: 'overview', label: '概览', href: `/${org}/overview`, icon: 'grid' },
      { key: 'requirements', label: '需求', href: `/${org}/requirements`, icon: 'list' },
      { key: 'iterations', label: '迭代', href: `/${org}/iterations`, icon: 'cycle' },
      { key: 'reviews', label: '评审', href: `/${org}/reviews`, icon: 'review' },
      { key: 'documents', label: '文档', href: `/${org}/documents`, icon: 'doc' },
    ],
    settings: isOrgAdminRole(orgRole)
      ? SETTINGS.map(([key, label, icon]) => ({ key, label, icon, href: `/${org}/settings/${key}` }))
      : [],
  };
}

export function activeNavKey(pathname: string, org: string): string {
  const rest = pathname.replace(new RegExp(`^/${org}`), '');
  if (/^\/requirements(\/|$)/.test(rest)) return 'requirements';
  if (/^\/iterations(\/|$)/.test(rest)) return 'iterations';
  if (/^\/workload(\/|$)/.test(rest)) return 'iterations';
  if (/^\/reviews(\/|$)/.test(rest)) return 'reviews';
  if (/^\/documents(\/|$)/.test(rest)) return 'documents';
  if (/^\/overview(\/|$)/.test(rest)) return 'overview';
  const m = /^\/settings\/([^/]+)/.exec(rest);
  return m ? m[1]! : 'home';
}
