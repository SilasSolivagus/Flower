DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['work_items', 'progress_updates'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      $p$CREATE POLICY tenant_isolation ON %I
        USING (current_setting('app.scope', true) = 'system'
               OR org_id = nullif(current_setting('app.org_id', true), '')::uuid)
        WITH CHECK (current_setting('app.scope', true) = 'system'
               OR org_id = nullif(current_setting('app.org_id', true), '')::uuid)$p$,
      t);
  END LOOP;
END
$$;
--> statement-breakpoint
-- 回填加入跟进的时间：当前处于未开始、进行中类别，未删除、尚未加入且未手动移出的需求，
-- 取最近一次从这两类之外（或创建）进入这两类的流转时间；没有这样的流转时取 state_changed_at
WITH st AS (
  SELECT p.id AS product_id, s->>'key' AS key, s->>'category' AS category
  FROM products p
  JOIN workflow_versions v ON v.id = p.workflow_version_id,
  jsonb_array_elements(v.body->'states') s
),
cur AS (
  SELECT r.id, r.product_id, r.state_changed_at
  FROM requirements r
  JOIN st ON st.product_id = r.product_id AND st.key = r.state_key
  WHERE r.deleted_at IS NULL AND r.tracked_since IS NULL AND NOT r.tracking_opted_out
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
WHERE r.id = cur.id;
--> statement-breakpoint
-- 补齐内置字段「类型」（作用于需求）与「工作类型」（作用于工作项）；已有同 key 组织级字段的组织跳过
INSERT INTO field_definitions (id, org_id, product_id, key, label, cardinality, builtin, applies_to, created_at)
SELECT gen_random_uuid(), o.id, NULL, f.key, f.label, 'single', true, f.applies_to, now()
FROM organizations o
CROSS JOIN (VALUES ('type', '类型', 'requirement'), ('work_type', '工作类型', 'work_item')) AS f(key, label, applies_to)
WHERE NOT EXISTS (SELECT 1 FROM field_definitions d WHERE d.org_id = o.id AND d.product_id IS NULL AND d.key = f.key);
--> statement-breakpoint
-- 预置选项：只给还没有任何选项的这两个内置字段补
INSERT INTO field_options (id, org_id, field_id, key, label, color, sort, active)
SELECT gen_random_uuid(), d.org_id, d.id, o.key, o.label, o.color, o.sort, true
FROM field_definitions d
JOIN (VALUES
  ('type', 'feature', '新功能', '#2563eb', 0),
  ('type', 'improvement', '体验优化', '#0f766e', 1),
  ('type', 'incident', '线上问题', '#dc2626', 2),
  ('work_type', 'support', '技术支持', '#7c3aed', 0),
  ('work_type', 'coordination', '协调对接', '#ea580c', 1)
) AS o(field_key, key, label, color, sort) ON o.field_key = d.key
WHERE d.product_id IS NULL AND d.builtin
  AND NOT EXISTS (SELECT 1 FROM field_options x WHERE x.field_id = d.id);
