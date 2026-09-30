import type { AccountView } from '../src/auth/accounts';
import type { Db } from '../src/db/client';
import type { WorkflowBody } from '../src/definitions/workflow-schema';
import type { Actor } from '../src/domain-types';
import { initializeInstance } from '../src/setup/instance';
import { type OrgView, resolveActor } from '../src/tenancy/orgs';
import { createPlaceholderMember } from '../src/tenancy/members';

export const OWNER_EMAIL = 'owner@example.com';
export const OWNER_PASSWORD = 'password123';

/** 初始化实例，返回实例管理员账号、组织 acme 及其 owner 操作者。 */
export async function seedInstance(db: Db): Promise<{ account: AccountView; org: OrgView; owner: Actor }> {
  const { account, org } = await initializeInstance(db, {
    admin: { email: OWNER_EMAIL, name: 'Owner', password: OWNER_PASSWORD },
    org: { name: '测试组织', slug: 'acme' },
  });
  const owner = await resolveActor(db, account.id, 'acme');
  if (!owner) throw new Error('seedInstance: 无法解析 owner');
  return { account, org, owner };
}

/** 新建一个占位成员，返回以该成员身份操作的 Actor（沿用 owner 的组织信息，替换 memberId 与组织角色）。 */
export async function asMember(db: Db, owner: Actor, displayName: string, orgRole: Actor['orgRole'] = 'member'): Promise<Actor> {
  const m = await createPlaceholderMember(db, owner, { displayName });
  return { ...owner, memberId: m.id, orgRole, accountId: null };
}

/** 新建常规迭代的输入构造。 */
export const regularIteration = (productId: string, name: string, startDate: string, endDate: string) =>
  ({ type: 'regular' as const, productId, name, startDate, endDate });

/** 只读范围（全部产品）的 API Token Actor。 */
export function readOnlyToken(owner: Actor): Actor {
  return { ...owner, tokenId: '00000000-0000-0000-0000-0000000000f1', tokenScope: { products: 'all', access: 'read' } };
}

/** 带 join_iteration 准入条件（「可行性」检查项需通过）的流程，供加入迭代相关测试共用。 */
export const GATED_WORKFLOW: WorkflowBody = {
  states: [
    { key: 'backlog', label: '收集', color: '#94a3b8', order: 1, group: '', category: 'backlog' },
    { key: 'done', label: '已上线', color: '#10b981', order: 2, group: '', category: 'completed' },
  ],
  initial: 'backlog',
  transitions: [
    { from: '*', to: 'backlog', conditions: [] },
    { from: '*', to: 'done', conditions: [] },
  ],
  actionGates: [{ action: 'join_iteration', conditions: [{ type: 'check_item', item: 'feasibility', in: ['passed'] }] }],
  checkItems: [{ key: 'feasibility', label: '可行性', scope: 'requirement', type: 'single', defaultState: 'not_started' }],
};

/**
 * 带「可行性」「设计签字」「PRD」三个需求检查项的流程；设计签字由设计标签与一位指定成员会签。
 * 状态含进行中、已上线（已完成类）、已搁置（已取消类）。评审队列与工作台测试共用。
 */
export function reviewWorkflow(designTagId: string, bossMemberId: string): WorkflowBody {
  return {
    states: [
      { key: 'backlog', label: '收集', color: '#94a3b8', order: 1, group: '', category: 'backlog' },
      { key: 'doing', label: '开发中', color: '#f59e0b', order: 2, group: '', category: 'started' },
      { key: 'done', label: '已上线', color: '#10b981', order: 3, group: '', category: 'completed' },
      { key: 'dropped', label: '已搁置', color: '#9ca3af', order: 4, group: '', category: 'canceled' },
    ],
    initial: 'backlog',
    transitions: [
      { from: '*', to: 'backlog', conditions: [] },
      { from: '*', to: 'doing', conditions: [] },
      { from: '*', to: 'done', conditions: [] },
      { from: '*', to: 'dropped', conditions: [] },
    ],
    actionGates: [],
    checkItems: [
      { key: 'feasibility', label: '可行性', scope: 'requirement', type: 'single', defaultState: 'not_started' },
      {
        key: 'design',
        label: '设计签字',
        scope: 'requirement',
        type: 'signoff',
        signers: [
          { by: 'function_tag', ref: designTagId },
          { by: 'member', ref: bossMemberId },
        ],
        signoffRule: 'all',
        defaultState: 'not_started',
      },
      { key: 'prd', label: 'PRD', scope: 'requirement', type: 'single', defaultState: 'not_started' },
    ],
  };
}
