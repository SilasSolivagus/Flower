import { eq } from 'drizzle-orm';
import { fieldDefinitions, fieldOptions, functionTags, workflowDefinitions, workflowVersions } from '../db/schema';
import type { Tx } from '../db/tx';
import { insertPresetTemplate } from '../documents/templates';
import type { WorkflowBody } from './workflow-schema';

export const DEFAULT_LEVEL_NAMES = ['业务域', '模块', '功能点'];

const STATES: WorkflowBody['states'] = [
  { key: 'backlog', label: '待处理', color: '#94a3b8', order: 1, group: '规划', category: 'backlog' },
  { key: 'todo', label: '待开始', color: '#60a5fa', order: 2, group: '执行', category: 'unstarted' },
  { key: 'doing', label: '进行中', color: '#f59e0b', order: 3, group: '执行', category: 'started' },
  { key: 'done', label: '已完成', color: '#10b981', order: 4, group: '执行', category: 'completed' },
  { key: 'canceled', label: '已取消', color: '#9ca3af', order: 5, group: '执行', category: 'canceled' },
];

export const DEFAULT_WORKFLOW_BODY: WorkflowBody = {
  states: STATES,
  initial: 'backlog',
  transitions: STATES.map((s) => ({ from: '*', to: s.key, conditions: [] })),
  actionGates: [],
  checkItems: [],
};

export const BUILTIN_FIELDS: Array<{
  key: string;
  label: string;
  cardinality: 'single' | 'multi';
  options: Array<{ key: string; label: string; color: string }>;
}> = [
  {
    key: 'priority',
    label: '优先级',
    cardinality: 'single',
    options: [
      { key: 'p0', label: 'P0', color: '#dc2626' },
      { key: 'p1', label: 'P1', color: '#ea580c' },
      { key: 'p2', label: 'P2', color: '#ca8a04' },
      { key: 'p3', label: 'P3', color: '#64748b' },
    ],
  },
  { key: 'platform', label: '平台', cardinality: 'multi', options: [] },
  { key: 'source', label: '来源', cardinality: 'single', options: [] },
  { key: 'line', label: '业务线', cardinality: 'single', options: [] },
];

export const DEFAULT_FUNCTION_TAGS = [
  { name: '产品经理', color: '#0f766e' },
  { name: '设计', color: '#7c3aed' },
  { name: '开发', color: '#2563eb' },
  { name: '测试', color: '#ea580c' },
];

/** 新组织的默认配置。调用方需已在 tx 上设置该组织的上下文。 */
export async function seedOrgDefaults(
  tx: Tx,
  orgId: string,
  createdBy: string,
): Promise<{ workflowDefinitionId: string; workflowVersionId: string }> {
  const [def] = await tx.insert(workflowDefinitions).values({ orgId, name: '默认流程' }).returning();
  const [ver] = await tx
    .insert(workflowVersions)
    .values({ orgId, definitionId: def!.id, version: 1, body: DEFAULT_WORKFLOW_BODY, note: '系统默认', createdBy })
    .returning();
  await tx.update(workflowDefinitions).set({ currentVersionId: ver!.id }).where(eq(workflowDefinitions.id, def!.id));

  for (const f of BUILTIN_FIELDS) {
    const [field] = await tx
      .insert(fieldDefinitions)
      .values({ orgId, key: f.key, label: f.label, cardinality: f.cardinality, builtin: true })
      .returning();
    if (f.options.length > 0) {
      await tx.insert(fieldOptions).values(f.options.map((o, i) => ({ orgId, fieldId: field!.id, ...o, sort: i })));
    }
  }

  await tx.insert(functionTags).values(DEFAULT_FUNCTION_TAGS.map((tag, i) => ({ orgId, ...tag, sort: i })));
  await insertPresetTemplate(tx, orgId);
  return { workflowDefinitionId: def!.id, workflowVersionId: ver!.id };
}
