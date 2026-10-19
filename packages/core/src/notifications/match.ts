import { and, arrayContains, eq } from 'drizzle-orm';
import { fieldDefinitions, fieldOptions, fieldValues, notificationDeliveries, notificationDigestItems, notificationRules, requirements, structureNodes } from '../db/schema';
import type { Tx } from '../db/tx';
import { MAX_STRUCTURE_DEPTH } from '../structure/nodes';
import { usableChannelsTx } from './channels';
import { isNotifiableEventType, type RuleFilter } from './constants';
import { parseRuleFilter } from './rules';

export type MatchEvent = { id: string; orgId: string; productId: string; type: string; subjectType: string; subjectId: string; payload: Record<string, unknown> };
/** 过滤要用的事实：需求主体的状态、优先级 key、所在节点及其上级；PRD 变化后的状态；变化的字段 key。不适用的为 null。 */
export type EventFacts = {
  requirement: { stateKey: string; priorities: string[]; nodePath: string[] } | null;
  documentStatus: string | null;
  changedFields: string[] | null;
};

const hit = (want: string[] | undefined, have: string[]): boolean => !want || want.length === 0 || want.some((w) => have.includes(w));

/** 条件之间为且、条件内为或；不适用于该事件的条件视为通过。 */
export function ruleMatches(filter: RuleFilter, facts: EventFacts): boolean {
  if (facts.requirement) {
    if (!hit(filter.states, [facts.requirement.stateKey])) return false;
    if (!hit(filter.priorities, facts.requirement.priorities)) return false;
    if (!hit(filter.nodeIds, facts.requirement.nodePath)) return false;
  }
  if (facts.documentStatus !== null && !hit(filter.documentStatuses, [facts.documentStatus])) return false;
  if (facts.changedFields !== null && !hit(filter.fields, facts.changedFields)) return false;
  return true;
}

const changesOf = (payload: Record<string, unknown>): Array<{ field?: unknown; new?: unknown }> =>
  Array.isArray(payload.changes) ? (payload.changes as Array<{ field?: unknown; new?: unknown }>) : [];

export async function eventFactsTx(tx: Tx, ev: MatchEvent): Promise<EventFacts> {
  let requirement: EventFacts['requirement'] = null;
  if (ev.subjectType === 'requirement') {
    const [req] = await tx.select({ stateKey: requirements.stateKey, nodeId: requirements.nodeId }).from(requirements).where(eq(requirements.id, ev.subjectId));
    if (req) {
      const pri = await tx
        .select({ key: fieldOptions.key })
        .from(fieldValues)
        .innerJoin(fieldOptions, eq(fieldOptions.id, fieldValues.optionId))
        .innerJoin(fieldDefinitions, eq(fieldDefinitions.id, fieldValues.fieldId))
        .where(and(eq(fieldValues.entityId, ev.subjectId), eq(fieldDefinitions.key, 'priority')));
      const nodePath: string[] = [];
      let nodeId = req.nodeId;
      while (nodeId && nodePath.length < MAX_STRUCTURE_DEPTH) {
        nodePath.push(nodeId);
        const [n] = await tx.select({ parentId: structureNodes.parentId }).from(structureNodes).where(eq(structureNodes.id, nodeId));
        nodeId = n?.parentId ?? null;
      }
      requirement = { stateKey: req.stateKey, priorities: pri.map((p) => p.key), nodePath };
    }
  }
  const status = ev.type === 'document.status_changed' ? changesOf(ev.payload).find((c) => c.field === 'status')?.new : undefined;
  return {
    requirement,
    documentStatus: typeof status === 'string' ? status : null,
    changedFields: ev.type === 'requirement.field_changed' ? changesOf(ev.payload).map((c) => String(c.field)) : null,
  };
}

/**
 * 在写入领域事件的同一事务内匹配本产品启用的规则：即时规则为每个仍可用的通道写一条待发记录（payload 为空，
 * 由后台发送在第一次发送前渲染）；摘要规则写摘要条目。没有规则时只多一次查询。
 * 规则与通道读取时加 FOR KEY SHARE，与删除规则、通道的 FOR UPDATE 串行：删除先提交则这里读不到该行，
 * 这里先读到则删除会看到新记录并报「只能停用」。
 */
export async function matchNotificationRules(tx: Tx, ev: MatchEvent): Promise<void> {
  // 简报沿用 document.status_changed（payload.kind = 'brief'），不当作「PRD 状态变化」推送（设计 §5）
  if (!isNotifiableEventType(ev.type) || ev.payload.kind === 'brief') return;
  const rules = await tx
    .select()
    .from(notificationRules)
    .where(and(eq(notificationRules.productId, ev.productId), eq(notificationRules.enabled, true), arrayContains(notificationRules.eventTypes, [ev.type])))
    .for('key share');
  if (rules.length === 0) return;
  // 存储的过滤条件有误时只跳过该规则，其余规则照常匹配
  const parsed = rules.flatMap((rule) => {
    try {
      return [{ rule, filter: parseRuleFilter(rule.filter) }];
    } catch {
      console.warn(`[notify] 事件规则的过滤条件有误，已跳过：rule=${rule.id} event=${ev.id}`);
      return [];
    }
  });
  const facts = parsed.some((p) => Object.keys(p.filter).length > 0) ? await eventFactsTx(tx, ev) : null;
  const now = new Date();
  for (const { rule, filter } of parsed) {
    if (facts && !ruleMatches(filter, facts)) continue;
    if (rule.mode === 'digest') {
      await tx.insert(notificationDigestItems).values({ orgId: ev.orgId, ruleId: rule.id, scheduleId: rule.digestScheduleId!, eventId: ev.id }).onConflictDoNothing();
      continue;
    }
    const channels = await usableChannelsTx(tx, rule.channelIds, ev.productId, { lock: true });
    if (channels.length === 0) continue;
    await tx
      .insert(notificationDeliveries)
      .values(channels.map((c) => ({ orgId: ev.orgId, kind: 'rule' as const, ruleId: rule.id, channelId: c.id, eventId: ev.id, status: 'pending' as const, nextAttemptAt: now })));
  }
}
