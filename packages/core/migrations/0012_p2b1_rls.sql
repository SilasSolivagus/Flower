ALTER TABLE entity_links ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON entity_links
  USING (current_setting('app.scope', true) = 'system'
         OR org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.scope', true) = 'system'
         OR org_id = nullif(current_setting('app.org_id', true), '')::uuid);
