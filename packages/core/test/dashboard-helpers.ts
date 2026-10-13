import { eq } from 'drizzle-orm';
import type { Db } from '../src/db/client';
import { requirements, stateTransitions } from '../src/db/schema';

/**
 * 用管理员连接改写需求的流转历史：先删除原有流转，再写入「created 时创建于 backlog」与 steps 里依次进入的状态，
 * 并把需求的当前状态、创建时间、状态变更时间同步为最后一步。时刻用 ISO 字符串（带时区）。
 */
export async function rewriteHistory(adminDb: Db, orgId: string, requirementId: string, created: string, steps: Array<[string, string]>): Promise<void> {
  const rows: Array<{ fromState: string | null; toState: string; at: Date }> = [{ fromState: null, toState: 'backlog', at: new Date(created) }];
  let prev = 'backlog';
  for (const [to, when] of steps) {
    rows.push({ fromState: prev, toState: to, at: new Date(when) });
    prev = to;
  }
  await adminDb.delete(stateTransitions).where(eq(stateTransitions.requirementId, requirementId));
  await adminDb.insert(stateTransitions).values(rows.map((r) => ({ orgId, requirementId, ...r })));
  await adminDb
    .update(requirements)
    .set({ stateKey: prev, createdAt: new Date(created), stateChangedAt: rows.at(-1)!.at })
    .where(eq(requirements.id, requirementId));
}
