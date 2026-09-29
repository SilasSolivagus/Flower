CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'structure_nodes', 'iterations', 'iteration_scope_snapshots', 'releases', 'requirements',
    'requirement_releases', 'field_values', 'requirement_assignments', 'requirement_relations',
    'state_transitions', 'blockers', 'check_item_results', 'check_item_signoffs', 'tasks',
    'comments', 'comment_reads', 'entity_aliases'
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
ALTER TABLE iterations ADD CONSTRAINT iterations_regular_no_overlap
  EXCLUDE USING gist (product_id WITH =, daterange(start_date, end_date, '[)') WITH &&)
  WHERE (type = 'regular' AND deleted_at IS NULL);
