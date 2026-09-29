import type { OrgRole } from '@/lib/types';

export type NavIcon = 'home' | 'list' | 'cycle' | 'doc' | 'users' | 'tag' | 'box' | 'flow' | 'sliders' | 'bot' | 'building';
export type NavItem = { key: string; label: string; href?: string; icon: NavIcon; phase?: 'P1' | 'P2' };

export const isOrgAdminRole = (role: OrgRole): boolean => role === 'owner' || role === 'admin';

const SETTINGS: Array<[string, string, NavIcon]> = [
  ['members', '成员', 'users'],
  ['tags', '职能标签', 'tag'],
  ['products', '产品', 'box'],
  ['workflows', '流程模板', 'flow'],
  ['fields', '字段字典', 'sliders'],
  ['agents', 'Agent 与 Token', 'bot'],
  ['general', '组织信息', 'building'],
];

export function buildNav(org: string, orgRole: OrgRole): { main: NavItem[]; settings: NavItem[] } {
  return {
    main: [
      { key: 'home', label: '概览', href: `/${org}`, icon: 'home' },
      { key: 'requirements', label: '需求', icon: 'list', phase: 'P1' },
      { key: 'iterations', label: '迭代', icon: 'cycle', phase: 'P1' },
      { key: 'documents', label: '文档', icon: 'doc', phase: 'P2' },
    ],
    settings: isOrgAdminRole(orgRole)
      ? SETTINGS.map(([key, label, icon]) => ({ key, label, icon, href: `/${org}/settings/${key}` }))
      : [],
  };
}

export function activeNavKey(pathname: string, org: string): string {
  const rest = pathname.replace(new RegExp(`^/${org}`), '');
  const m = /^\/settings\/([^/]+)/.exec(rest);
  return m ? m[1]! : 'home';
}
