import { z } from 'zod';

export const STATE_CATEGORIES = ['backlog', 'unstarted', 'started', 'completed', 'canceled'] as const;
export const CHECK_STATES = ['not_started', 'in_progress', 'passed', 'rejected', 'not_needed'] as const;

const key = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, 'key 只能包含小写字母、数字和下划线，并以字母开头');
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, '颜色格式应为 #RRGGBB');
const label = z.string().trim().min(1, '名称不能为空').max(20, '名称不超过 20 个字符');

export const conditionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('check_item'), item: key, in: z.array(z.enum(CHECK_STATES)).min(1) }),
  z.object({ type: z.literal('field_set'), field: key }),
  z.object({ type: z.literal('has_iteration') }),
  z.object({ type: z.literal('has_change_document') }),
]);
export type Condition = z.infer<typeof conditionSchema>;

export const stateSchema = z.object({
  key,
  label,
  color,
  order: z.number().int(),
  group: z.string().trim().max(20).default(''),
  category: z.enum(STATE_CATEGORIES),
});

export const transitionSchema = z.object({
  from: z.union([key, z.literal('*')]),
  to: key,
  label: z.string().max(20).optional(),
  conditions: z.array(conditionSchema).default([]),
});

export const checkItemSchema = z.object({
  key,
  label,
  scope: z.enum(['requirement', 'document']),
  type: z.enum(['single', 'signoff']),
  signers: z.array(z.object({ by: z.enum(['function_tag', 'member', 'product_role']), ref: z.string().min(1) })).optional(),
  signoffRule: z.enum(['all', 'any']).optional(),
  auto: z.literal('prd_status').optional(),
  defaultState: z.enum(CHECK_STATES).default('not_started'),
});

export const workflowBodySchema = z.object({
  states: z.array(stateSchema).min(1, '至少需要一个状态'),
  initial: key,
  transitions: z.array(transitionSchema).default([]),
  actionGates: z.array(z.object({ action: z.literal('join_iteration'), conditions: z.array(conditionSchema) })).default([]),
  checkItems: z.array(checkItemSchema).default([]),
});

export type WorkflowBody = z.infer<typeof workflowBodySchema>;
export type ValidationIssue = { path: string; message: string };

export function validateWorkflowBody(
  input: unknown,
  ctx: { fieldKeys: string[] },
): { ok: true; body: WorkflowBody } | { ok: false; issues: ValidationIssue[] } {
  const parsed = workflowBodySchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) };
  }
  const b = parsed.data;
  const issues: ValidationIssue[] = [];

  const stateKeys = new Set<string>();
  b.states.forEach((s, i) => {
    if (stateKeys.has(s.key)) issues.push({ path: `states.${i}.key`, message: `状态 key「${s.key}」重复` });
    stateKeys.add(s.key);
  });
  if (!stateKeys.has(b.initial)) issues.push({ path: 'initial', message: `初始状态「${b.initial}」不存在` });

  const itemKeys = new Set<string>();
  b.checkItems.forEach((c, i) => {
    const path = `checkItems.${i}`;
    if (itemKeys.has(c.key)) issues.push({ path: `${path}.key`, message: `检查项 key「${c.key}」重复` });
    itemKeys.add(c.key);
    if (c.type === 'signoff' && (!c.signers?.length || !c.signoffRule)) {
      issues.push({ path, message: '会签检查项必须指定签字人和会签规则' });
    }
    if (c.type === 'single' && (c.signers?.length || c.signoffRule)) {
      issues.push({ path, message: '普通检查项不能设置签字人或会签规则' });
    }
    if (c.auto === 'prd_status' && c.scope !== 'document') {
      issues.push({ path: `${path}.auto`, message: '自动同步 PRD 状态的检查项作用范围必须是 PRD' });
    }
  });

  const fieldKeys = new Set(ctx.fieldKeys);
  const checkConditions = (conds: Condition[], path: string) =>
    conds.forEach((c, j) => {
      if (c.type === 'check_item' && !itemKeys.has(c.item)) {
        issues.push({ path: `${path}.${j}`, message: `条件引用了不存在的检查项「${c.item}」` });
      }
      if (c.type === 'field_set' && !fieldKeys.has(c.field)) {
        issues.push({ path: `${path}.${j}`, message: `条件引用了不存在的字段「${c.field}」` });
      }
    });

  const pairs = new Set<string>();
  b.transitions.forEach((tr, i) => {
    const path = `transitions.${i}`;
    if (tr.from !== '*' && !stateKeys.has(tr.from)) issues.push({ path: `${path}.from`, message: `流转起点「${tr.from}」不存在` });
    if (!stateKeys.has(tr.to)) issues.push({ path: `${path}.to`, message: `流转终点「${tr.to}」不存在` });
    if (tr.from === tr.to) issues.push({ path, message: '流转的起点和终点不能相同' });
    const pair = `${tr.from}->${tr.to}`;
    if (pairs.has(pair)) issues.push({ path, message: `流转「${pair}」重复` });
    pairs.add(pair);
    checkConditions(tr.conditions, `${path}.conditions`);
  });
  b.actionGates.forEach((g, i) => checkConditions(g.conditions, `actionGates.${i}.conditions`));

  return issues.length > 0 ? { ok: false, issues } : { ok: true, body: b };
}
