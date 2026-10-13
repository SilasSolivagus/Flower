import { and, eq, isNull } from 'drizzle-orm';
import { organizations, products, requirements, stateTransitions, workflowVersions } from '../db/schema';
import type { Tx } from '../db/tx';
import type { WorkflowBody } from '../definitions/workflow-schema';
import { validZone } from '../notifications/sources';
import { DEFAULT_TIMEZONE } from '../tasks/tasks';
import { type CategoryOf, type FlowRequirement, prepareFlow, type RawTransition, type StateCategory } from './metrics';

export type StateMeta = { key: string; label: string; color: string; category: StateCategory };
export type RequirementMeta = { id: string; number: number; title: string; stateKey: string; iterationId: string | null };
export type ProductFlow = {
  productKey: string;
  states: StateMeta[];
  categoryOf: CategoryOf;
  checkItems: Array<{ key: string; label: string }>;
  requirements: FlowRequirement[];
  meta: Map<string, RequirementMeta>;
};

/** 组织时区；没有设置或设置无效（Intl 不认识）时用默认时区 Asia/Shanghai，不让看板因此报错。 */
export async function orgTimeZone(tx: Tx, orgId: string): Promise<string> {
  const [org] = await tx.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, orgId));
  return validZone(org?.settings.timezone) ?? DEFAULT_TIMEZONE;
}

/**
 * 读取产品的看板基础数据：当前流程的状态（类别）与检查项、未删除的需求及其全部流转（换算为组织时区的日期）。
 * 产品没有流程时状态为空，所有状态按 backlog 计。调用方已确认操作者能看到该产品。
 */
export async function loadProductFlow(tx: Tx, productId: string, timeZone: string): Promise<ProductFlow> {
  const [product] = await tx
    .select({ key: products.key, body: workflowVersions.body })
    .from(products)
    .leftJoin(workflowVersions, eq(workflowVersions.id, products.workflowVersionId))
    .where(eq(products.id, productId));
  const body = (product?.body ?? null) as WorkflowBody | null;
  const states: StateMeta[] = (body?.states ?? []).map((s) => ({ key: s.key, label: s.label, color: s.color, category: s.category }));
  const categoryByKey = new Map(states.map((s) => [s.key, s.category]));
  const categoryOf: CategoryOf = (key) => categoryByKey.get(key) ?? 'backlog';

  const live = and(eq(requirements.productId, productId), isNull(requirements.deletedAt));
  const rows = await tx
    .select({
      id: requirements.id,
      number: requirements.number,
      title: requirements.title,
      stateKey: requirements.stateKey,
      iterationId: requirements.iterationId,
      createdAt: requirements.createdAt,
    })
    .from(requirements)
    .where(live);
  const transitions =
    rows.length > 0
      ? await tx
          .select({ requirementId: stateTransitions.requirementId, fromState: stateTransitions.fromState, toState: stateTransitions.toState, at: stateTransitions.at })
          .from(stateTransitions)
          .innerJoin(requirements, eq(requirements.id, stateTransitions.requirementId))
          .where(live)
      : [];
  const byRequirement = new Map<string, RawTransition[]>();
  for (const t of transitions) {
    const list = byRequirement.get(t.requirementId);
    const item = { fromState: t.fromState, toState: t.toState, at: t.at };
    if (list) list.push(item);
    else byRequirement.set(t.requirementId, [item]);
  }
  return {
    productKey: product?.key ?? '',
    states,
    categoryOf,
    checkItems: (body?.checkItems ?? []).map((c) => ({ key: c.key, label: c.label })),
    requirements: prepareFlow(
      rows.map((r) => ({ id: r.id, createdAt: r.createdAt, stateKey: r.stateKey, transitions: byRequirement.get(r.id) ?? [] })),
      timeZone,
    ),
    meta: new Map(rows.map((r) => [r.id, { id: r.id, number: r.number, title: r.title, stateKey: r.stateKey, iterationId: r.iterationId }])),
  };
}
