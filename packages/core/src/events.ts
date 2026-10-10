import { domainEvents } from './db/schema';
import type { Tx } from './db/tx';
import type { Actor } from './domain-types';
import { isNotifiableEventType } from './notifications/constants';
import { matchNotificationRules } from './notifications/match';

export type EventInput = {
  orgId: string;
  productId?: string | null;
  type: string;
  subjectType: string;
  subjectId: string;
  actor: Actor | null;
  payload?: Record<string, unknown>;
};

/** 必须在业务修改所在的同一个事务里调用。返回事件 id。 */
export async function recordEvent(tx: Tx, e: EventInput): Promise<string> {
  const payload = { schemaVersion: 1, ...(e.payload ?? {}) };
  const [row] = await tx
    .insert(domainEvents)
    .values({
      orgId: e.orgId,
      productId: e.productId ?? null,
      type: e.type,
      subjectType: e.subjectType,
      subjectId: e.subjectId,
      actorMemberId: e.actor?.memberId ?? null,
      actorTokenId: e.actor?.tokenId ?? null,
      payload,
    })
    .returning({ id: domainEvents.id });
  const id = row!.id;
  // 推送：同一事务内匹配本产品的事件规则，只写待发记录或摘要条目，不在这里渲染或发送。
  // 匹配放在 savepoint 里：出错只回滚推送部分并记警告，业务写入照常提交。
  if (e.productId && isNotifiableEventType(e.type)) {
    const ev = { id, orgId: e.orgId, productId: e.productId, type: e.type, subjectType: e.subjectType, subjectId: e.subjectId, payload };
    try {
      await tx.transaction((sp) => matchNotificationRules(sp, ev));
    } catch (err) {
      // drizzle 的查询错误把 SQL 与参数写进 message，只记底层原因
      const cause = err instanceof Error && err.cause instanceof Error ? err.cause : err;
      console.warn(`[notify] 事件规则匹配失败，本事件不推送：event=${id} type=${e.type}：${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
  return id;
}
