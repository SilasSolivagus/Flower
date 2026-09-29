import type { OrgRole, ProductRole } from './types';

export const ORG_ROLE_LABEL: Record<OrgRole, string> = { owner: '所有者', admin: '管理员', member: '成员', guest: '访客' };
export const PRODUCT_ROLE_LABEL: Record<ProductRole, string> = { admin: '管理员', editor: '编辑', viewer: '只读' };
export const MEMBER_KIND_LABEL = { account: '账号', none: '无账号', agent: 'Agent' } as const;
export const CATEGORY_LABEL = {
  backlog: '未排期',
  unstarted: '未开始',
  started: '进行中',
  completed: '已完成',
  canceled: '已取消',
} as const;
export const CATEGORY_COLOR = {
  backlog: '#8a9199',
  unstarted: '#2f6fd6',
  started: '#b7791f',
  completed: '#1e8a5a',
  canceled: '#5c6570',
} as const;
export const CHECK_STATE_LABEL = {
  not_started: '未开始',
  in_progress: '进行中',
  passed: '通过',
  rejected: '驳回',
  not_needed: '不需要',
} as const;
export const SWATCHES = ['#1f6f54', '#0f766e', '#2f6fd6', '#7c3aed', '#db2777', '#b42318', '#b7791f', '#1e8a5a', '#5c6570', '#8a9199'];
