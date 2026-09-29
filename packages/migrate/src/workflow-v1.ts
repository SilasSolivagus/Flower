import { type CheckState, DEFAULT_FUNCTION_TAGS, type WorkflowBody } from '@flower/core';

export const V1_STATES: WorkflowBody['states'] = [
  { key: 'collect', label: '收集', color: '#94a3b8', order: 1, group: '分析', category: 'backlog' },
  { key: 'to_evaluate', label: '待评估', color: '#a78bfa', order: 2, group: '分析', category: 'backlog' },
  { key: 'evaluated', label: '已评估', color: '#818cf8', order: 3, group: '分析', category: 'backlog' },
  { key: 'to_design', label: '待设计', color: '#60a5fa', order: 4, group: '开发', category: 'unstarted' },
  { key: 'to_develop', label: '待开发', color: '#38bdf8', order: 5, group: '开发', category: 'unstarted' },
  { key: 'designing', label: '设计中', color: '#f59e0b', order: 6, group: '开发', category: 'started' },
  { key: 'developing', label: '开发中', color: '#f97316', order: 7, group: '开发', category: 'started' },
  { key: 'testing', label: '测试中', color: '#eab308', order: 8, group: '开发', category: 'started' },
  { key: 'launched', label: '已上线', color: '#10b981', order: 9, group: '开发', category: 'completed' },
  { key: 'rejected', label: '已拒绝', color: '#9ca3af', order: 10, group: '', category: 'canceled' },
  { key: 'shelved', label: '已搁置', color: '#6b7280', order: 11, group: '', category: 'canceled' },
];

export const PLANE_STATUS_TO_STATE: Record<string, string> = Object.fromEntries(V1_STATES.map((s) => [s.label, s.key]));
/** 123plane 历史上用过、但当前状态列表里已经没有对应标签的写法。 */
export const PLANE_LEGACY_STATUS_ALIASES: Record<string, string> = { 已暂停: 'shelved' };

export function planeStatusToState(label: string | null | undefined): string | undefined {
  const l = label ?? '';
  return PLANE_STATUS_TO_STATE[l] ?? PLANE_LEGACY_STATUS_ALIASES[l];
}

export const SIGNOFF_ROLES = ['UI', '线条负责人', '产品负责人', '饶总'] as const;
export const BOSS_ROLE = '饶总';
export const SIGNOFF_ROLE_TAG: Record<string, string> = { UI: '设计', 线条负责人: '线条负责人', 产品负责人: '产品负责人' };
export const EXTRA_FUNCTION_TAGS = ['线条负责人', '产品负责人'];
export const ALL_FUNCTION_TAG_NAMES = [...DEFAULT_FUNCTION_TAGS.map((t) => t.name), ...EXTRA_FUNCTION_TAGS];

export function buildWorkflowV1Body(tagIdByName: Map<string, string>, bossMemberId: string): WorkflowBody {
  const tag = (name: string) => {
    const id = tagIdByName.get(name);
    if (!id) throw new Error(`缺少职能标签「${name}」`);
    return id;
  };
  const feasible = [{ type: 'check_item' as const, item: 'feasibility', in: ['passed', 'not_needed'] as CheckState[] }];
  return {
    states: V1_STATES,
    initial: 'collect',
    transitions: V1_STATES.map((s) => ({ from: '*', to: s.key, conditions: s.key === 'to_design' || s.key === 'to_develop' ? feasible : [] })),
    actionGates: [],
    checkItems: [
      { key: 'background', label: '背景', scope: 'requirement', type: 'single', defaultState: 'not_started' },
      { key: 'feasibility', label: '可行性', scope: 'requirement', type: 'single', defaultState: 'not_started' },
      { key: 'industry', label: '行业', scope: 'requirement', type: 'single', defaultState: 'not_started' },
      {
        key: 'design_signoff',
        label: '设计签字',
        scope: 'requirement',
        type: 'signoff',
        signers: [
          { by: 'function_tag', ref: tag(SIGNOFF_ROLE_TAG.UI!) },
          { by: 'function_tag', ref: tag(SIGNOFF_ROLE_TAG['线条负责人']!) },
          { by: 'function_tag', ref: tag(SIGNOFF_ROLE_TAG['产品负责人']!) },
          { by: 'member', ref: bossMemberId },
        ],
        signoffRule: 'all',
        defaultState: 'not_started',
      },
      { key: 'prd', label: 'PRD', scope: 'requirement', type: 'single', defaultState: 'not_started' },
      { key: 'ai_review', label: 'AI 预审', scope: 'requirement', type: 'single', defaultState: 'not_started' },
    ],
  };
}

export const PRD_STATUS_TO_CHECK: Record<string, CheckState> = {
  'not-started': 'not_started', approved: 'passed', submitted: 'in_progress', 'in-progress': 'in_progress', 'not-needed': 'not_needed',
};
export const FEASIBILITY_TO_CHECK: Record<string, CheckState> = {
  'not-assessed': 'not_started', approved: 'passed', 'in-progress': 'in_progress', rejected: 'rejected',
};
export const PUSH_REVIEW_TO_CHECK: Record<string, CheckState> = { 待办: 'in_progress', 通过: 'passed', 打回: 'rejected' };
/** push 主状态对背景 / 可行性 / 行业三个检查项的含义；"已搁置"不影响检查项。 */
export const PUSH_STATUS_TO_CHECK: Record<string, CheckState | null> = {
  待排期: 'not_started', 评审中: 'in_progress', 待修订: 'rejected', 已通过: 'passed', 已进版本: 'passed',
  开发中: 'passed', 待验收: 'passed', 合格: 'passed', 已上线: 'passed', 已搁置: null,
};
export const SIGNOFF_DECISION: Record<string, 'passed' | 'rejected' | null> = { 通过: 'passed', 驳回: 'rejected', 打回: 'rejected', 未审: null };
export const PRIORITY_KEYS: Record<string, string> = { P0: 'p0', P1: 'p1', P2: 'p2', P3: 'p3', 绿色通道: 'green' };
export const PRIORITY_OPTIONS = [
  { key: 'p0', label: 'P0', color: '#dc2626' },
  { key: 'p1', label: 'P1', color: '#ea580c' },
  { key: 'p2', label: 'P2', color: '#ca8a04' },
  { key: 'p3', label: 'P3', color: '#64748b' },
  { key: 'green', label: '绿色通道', color: '#16a34a' },
];
export const LINE_OPTIONS = [
  { key: 'feature', label: '功能' },
  { key: 'business', label: '商业' },
];
export const SOURCE_OPTIONS = [
  { key: 'original', label: '原创' },
  { key: 'online_issue', label: '线上问题' },
];
export const PLANE_ITERATION_STATUS: Record<string, 'planning' | 'active' | 'done'> = { 未开始: 'planning', 进行中: 'active', 已完成: 'done' };
export const PUSH_VERSION_STATUS: Record<string, 'planning' | 'active' | 'done'> = { 规划中: 'planning', 进行中: 'active', 已发版: 'done' };
export const ITERATION_LOG_LABEL: Record<string, string> = { note: '备注', risk: '风险', change: '变更', removed: '移出' };
export const SUBTASK_STATUS: Record<string, 'todo' | 'doing' | 'done'> = { todo: 'todo', doing: 'doing', 'in-progress': 'doing', done: 'done' };
export const BLOCKER_STATUS: Record<string, 'active' | 'resolved'> = { active: 'active', resolved: 'resolved' };

export const DEFAULT_PLATFORM_OPTIONS = [
  { key: 'pc', label: 'PC客户端' },
  { key: 'mobile', label: '移动端' },
  { key: 'web', label: 'Web端' },
  { key: 'mini', label: '小程序' },
];
/** 已知写法（按 aliasKey 归一化后）→ 平台选项 key。 */
export const KNOWN_PLATFORM_ALIASES: Record<string, string[]> = {
  pc: ['pc'], pc客户端: ['pc'], 客户端: ['pc'],
  web: ['web'], web端: ['web'],
  app: ['mobile'], 移动端: ['mobile'], ios: ['mobile'], android: ['mobile'], 安卓: ['mobile'],
  小程序: ['mini'], mini: ['mini'],
  all: ['pc', 'mobile', 'web', 'mini'], 全端: ['pc', 'mobile', 'web', 'mini'], 全平台: ['pc', 'mobile', 'web', 'mini'],
  待确认: [],
};

export function parseProxySigner(by: string): { onBehalfOf: string; actor: string } | null {
  const m = /^代(.+?)\s*by\s*(.+)$/.exec(by.trim());
  return m ? { onBehalfOf: m[1]!.trim(), actor: m[2]!.trim() } : null;
}
