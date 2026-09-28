import { domainEvents } from './db/schema';
import type { Tx } from './db/tx';
import type { Actor } from './domain-types';

export type EventInput = {
  orgId: string;
  productId?: string | null;
  type: string;
  subjectType: string;
  subjectId: string;
  actor: Actor | null;
  payload?: Record<string, unknown>;
};

/** 必须在业务修改所在的同一个事务里调用。 */
export async function recordEvent(tx: Tx, e: EventInput): Promise<void> {
  await tx.insert(domainEvents).values({
    orgId: e.orgId,
    productId: e.productId ?? null,
    type: e.type,
    subjectType: e.subjectType,
    subjectId: e.subjectId,
    actorMemberId: e.actor?.memberId ?? null,
    actorTokenId: e.actor?.tokenId ?? null,
    payload: { schemaVersion: 1, ...(e.payload ?? {}) },
  });
}
