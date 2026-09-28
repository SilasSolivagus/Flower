import { sql } from 'drizzle-orm';
import type { Db } from './client';

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type Queryable = Db | Tx;

export async function setOrgContext(tx: Tx, orgId: string): Promise<void> {
  await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);
}

/** 在某个组织的上下文中执行：RLS 只放行该组织的数据。 */
export function withOrg<T>(db: Db, orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await setOrgContext(tx, orgId);
    return fn(tx);
  });
}

/** 跨组织查询，只允许用于登录、成员关系查找、Token 校验、邀请接受等少数场景。 */
export function withSystem<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.scope', 'system', true)`);
    return fn(tx);
  });
}
