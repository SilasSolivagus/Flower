DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'member_notifications', 'member_notification_prefs', 'subscriptions',
    'notification_cursors', 'wecom_apps', 'wecom_bind_states'
  ] LOOP
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
-- 上线时把每个组织的游标初始化为当前最新的事件：不为历史事件补发通知。没有事件的组织留空（从头处理，等价于从此刻开始）
INSERT INTO notification_cursors (org_id, last_occurred_at, last_event_id, updated_at)
SELECT o.id, e.occurred_at, e.id, now()
FROM organizations o
LEFT JOIN LATERAL (
  SELECT d.occurred_at, d.id FROM domain_events d WHERE d.org_id = o.id ORDER BY d.occurred_at DESC, d.id DESC LIMIT 1
) e ON true
ON CONFLICT (org_id) DO NOTHING;
