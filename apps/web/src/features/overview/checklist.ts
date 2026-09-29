import type { Field, Invitation, Member, Product, Token, WorkflowDefinition } from '@/lib/types';

export type ChecklistItem = { key: string; label: string; description: string; done: boolean; href: string };

export function computeChecklist(
  org: string,
  d: { members: Member[]; invitations: Invitation[]; products: Product[]; workflows: WorkflowDefinition[]; fields: Field[]; tokens: Token[] },
): ChecklistItem[] {
  const humansWithAccount = d.members.filter((m) => m.kind === 'human' && m.hasAccount && m.status === 'active');
  const agents = new Set(d.members.filter((m) => m.kind === 'agent').map((m) => m.id));
  const s = (p: string) => `/${org}/settings/${p}`;
  return [
    {
      key: 'invite',
      label: '邀请成员',
      description: '邀请团队加入，或先登记没有账号的业务提出人。',
      done: humansWithAccount.length > 1 || d.invitations.some((i) => !i.acceptedAt && !i.revokedAt),
      href: s('members'),
    },
    {
      key: 'tags',
      label: '配置职能标签',
      description: '给成员打上产品经理、设计、开发等标签，用于指定签字人。',
      done: d.members.some((m) => m.functionTagIds.length > 0),
      href: s('tags'),
    },
    { key: 'product', label: '创建产品', description: '设定产品名称和编号前缀，例如 PAN。', done: d.products.length > 0, href: s('products') },
    {
      key: 'workflow',
      label: '配置需求流程',
      description: '按团队的实际流程编辑状态、流转和检查项。',
      done: d.workflows.some((w) => (w.currentVersion ?? 0) > 1) || d.workflows.filter((w) => w.productId === null).length > 1,
      href: s('workflows'),
    },
    {
      key: 'fields',
      label: '补充字段字典',
      description: '为平台、来源、业务线等字段添加选项。',
      done: d.fields.some((f) => f.key === 'platform' && f.options.length > 0),
      href: s('fields'),
    },
    {
      key: 'agent',
      label: '接入 Agent',
      description: '创建 Agent 成员并签发有范围限制的 Token。',
      done: d.tokens.some((t) => agents.has(t.memberId) && !t.revokedAt),
      href: s('agents'),
    },
  ];
}
