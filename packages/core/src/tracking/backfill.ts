import { sql } from 'drizzle-orm';
import type { Tx } from '../db/tx';

/**
 * 为一个组织回填加入跟进的时间，规则与迁移 0020 的回填语句相同（多了组织条件）：
 * 当前处于未开始、进行中类别，未删除、尚未加入且未手动移出的需求，取最近一次从这两类之外（或创建）进入这两类的流转时间，
 * 没有这样的流转时取 state_changed_at。迁移工具导入旧数据后调用（系统写入，不记事件）。返回回填的需求数。
 */
export async function backfillTrackedSinceTx(tx: Tx, orgId: string): Promise<number> {
  const rows = await tx.execute(sql`
    WITH st AS (
      SELECT p.id AS product_id, s->>'key' AS key, s->>'category' AS category
      FROM products p
      JOIN workflow_versions v ON v.id = p.workflow_version_id,
      jsonb_array_elements(v.body->'states') s
      WHERE p.org_id = ${orgId}::uuid
    ),
    cur AS (
      SELECT r.id, r.product_id, r.state_changed_at
      FROM requirements r
      JOIN st ON st.product_id = r.product_id AND st.key = r.state_key
      WHERE r.org_id = ${orgId}::uuid AND r.deleted_at IS NULL AND r.tracked_since IS NULL AND NOT r.tracking_opted_out
        AND st.category IN ('unstarted', 'started')
    ),
    entry AS (
      SELECT tr.requirement_id, max(tr.at) AS at
      FROM state_transitions tr
      JOIN cur ON cur.id = tr.requirement_id
      JOIN st sto ON sto.product_id = cur.product_id AND sto.key = tr.to_state
      LEFT JOIN st sf ON sf.product_id = cur.product_id AND sf.key = tr.from_state
      WHERE sto.category IN ('unstarted', 'started')
        AND coalesce(sf.category, 'backlog') NOT IN ('unstarted', 'started')
      GROUP BY tr.requirement_id
    )
    UPDATE requirements r
    SET tracked_since = coalesce(entry.at, cur.state_changed_at)
    FROM cur LEFT JOIN entry ON entry.requirement_id = cur.id
    WHERE r.id = cur.id
    RETURNING r.id
  `);
  return (rows as unknown as unknown[]).length;
}
