CREATE TABLE "blockers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"requirement_id" uuid NOT NULL,
	"description" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"owner_member_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "check_item_results" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"item_key" text NOT NULL,
	"state" text NOT NULL,
	"note" text,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "check_item_signoffs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"result_id" uuid NOT NULL,
	"signer_member_id" uuid NOT NULL,
	"acted_by_member_id" uuid,
	"signer_rule_index" integer NOT NULL,
	"decision" text NOT NULL,
	"note" text,
	"evidence_link_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comment_reads" (
	"org_id" uuid NOT NULL,
	"comment_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "comment_reads_comment_id_member_id_pk" PRIMARY KEY("comment_id","member_id")
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"parent_id" uuid,
	"author_member_id" uuid,
	"body" text NOT NULL,
	"kind" text DEFAULT 'comment' NOT NULL,
	"anchor" jsonb,
	"anchor_state" text,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entity_aliases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"alias" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "field_values" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"option_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "iteration_scope_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"iteration_id" uuid NOT NULL,
	"requirement_id" uuid NOT NULL,
	"snapshot_kind" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "iterations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"product_id" uuid,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"legacy_key" text,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"baseline_end_date" date,
	"status" text DEFAULT 'planning' NOT NULL,
	"milestones" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "iterations_type_product" CHECK (("iterations"."type" = 'regular') = ("iterations"."product_id" is not null)),
	CONSTRAINT "iterations_dates" CHECK ("iterations"."start_date" <= "iterations"."end_date")
);
--> statement-breakpoint
CREATE TABLE "releases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"platform_option_id" uuid,
	"version_name" text NOT NULL,
	"iteration_id" uuid,
	"status" text DEFAULT 'planned' NOT NULL,
	"planned_date" date,
	"baseline_date" date,
	"released_at" timestamp with time zone,
	"notes" text,
	"legacy_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "requirement_assignments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"requirement_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"function_tag_id" uuid,
	"platform_option_id" uuid
);
--> statement-breakpoint
CREATE TABLE "requirement_relations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"from_id" uuid NOT NULL,
	"to_id" uuid NOT NULL,
	"type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "requirement_releases" (
	"org_id" uuid NOT NULL,
	"requirement_id" uuid NOT NULL,
	"release_id" uuid NOT NULL,
	CONSTRAINT "requirement_releases_requirement_id_release_id_pk" PRIMARY KEY("requirement_id","release_id")
);
--> statement-breakpoint
CREATE TABLE "requirements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"legacy_key" text,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"state_key" text NOT NULL,
	"state_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"owner_member_id" uuid,
	"requester_member_id" uuid,
	"node_id" uuid,
	"iteration_id" uuid,
	"change_document_id" uuid,
	"legacy_meta" jsonb,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "state_transitions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"requirement_id" uuid NOT NULL,
	"from_state" text,
	"to_state" text NOT NULL,
	"actor_member_id" uuid,
	"token_id" uuid,
	"forced" boolean DEFAULT false NOT NULL,
	"reason" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "structure_nodes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"parent_id" uuid,
	"depth" smallint NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"legacy_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "structure_nodes_parent_name" UNIQUE NULLS NOT DISTINCT("product_id","parent_id","name"),
	CONSTRAINT "structure_nodes_depth" CHECK ("structure_nodes"."depth" between 1 and 3)
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"requirement_id" uuid,
	"iteration_id" uuid,
	"title" text NOT NULL,
	"alias" text,
	"assignee_member_id" uuid,
	"status" text DEFAULT 'todo' NOT NULL,
	"plan_start" date,
	"plan_days" integer,
	"delay_days" integer,
	"phase" text,
	"flag" text,
	"starred" boolean,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"legacy_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "requirement_seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "blockers" ADD CONSTRAINT "blockers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blockers" ADD CONSTRAINT "blockers_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blockers" ADD CONSTRAINT "blockers_owner_member_id_members_id_fk" FOREIGN KEY ("owner_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_item_results" ADD CONSTRAINT "check_item_results_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_item_results" ADD CONSTRAINT "check_item_results_updated_by_members_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_item_signoffs" ADD CONSTRAINT "check_item_signoffs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_item_signoffs" ADD CONSTRAINT "check_item_signoffs_result_id_check_item_results_id_fk" FOREIGN KEY ("result_id") REFERENCES "public"."check_item_results"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_item_signoffs" ADD CONSTRAINT "check_item_signoffs_signer_member_id_members_id_fk" FOREIGN KEY ("signer_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_item_signoffs" ADD CONSTRAINT "check_item_signoffs_acted_by_member_id_members_id_fk" FOREIGN KEY ("acted_by_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_reads" ADD CONSTRAINT "comment_reads_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_reads" ADD CONSTRAINT "comment_reads_comment_id_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_reads" ADD CONSTRAINT "comment_reads_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_parent_id_comments_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."comments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_author_member_id_members_id_fk" FOREIGN KEY ("author_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_resolved_by_members_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_aliases" ADD CONSTRAINT "entity_aliases_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_values" ADD CONSTRAINT "field_values_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_values" ADD CONSTRAINT "field_values_field_id_field_definitions_id_fk" FOREIGN KEY ("field_id") REFERENCES "public"."field_definitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_values" ADD CONSTRAINT "field_values_option_id_field_options_id_fk" FOREIGN KEY ("option_id") REFERENCES "public"."field_options"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "iteration_scope_snapshots" ADD CONSTRAINT "iteration_scope_snapshots_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "iteration_scope_snapshots" ADD CONSTRAINT "iteration_scope_snapshots_iteration_id_iterations_id_fk" FOREIGN KEY ("iteration_id") REFERENCES "public"."iterations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "iteration_scope_snapshots" ADD CONSTRAINT "iteration_scope_snapshots_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "iterations" ADD CONSTRAINT "iterations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "iterations" ADD CONSTRAINT "iterations_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_platform_option_id_field_options_id_fk" FOREIGN KEY ("platform_option_id") REFERENCES "public"."field_options"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_iteration_id_iterations_id_fk" FOREIGN KEY ("iteration_id") REFERENCES "public"."iterations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_assignments" ADD CONSTRAINT "requirement_assignments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_assignments" ADD CONSTRAINT "requirement_assignments_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_assignments" ADD CONSTRAINT "requirement_assignments_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_assignments" ADD CONSTRAINT "requirement_assignments_function_tag_id_function_tags_id_fk" FOREIGN KEY ("function_tag_id") REFERENCES "public"."function_tags"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_assignments" ADD CONSTRAINT "requirement_assignments_platform_option_id_field_options_id_fk" FOREIGN KEY ("platform_option_id") REFERENCES "public"."field_options"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_relations" ADD CONSTRAINT "requirement_relations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_relations" ADD CONSTRAINT "requirement_relations_from_id_requirements_id_fk" FOREIGN KEY ("from_id") REFERENCES "public"."requirements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_relations" ADD CONSTRAINT "requirement_relations_to_id_requirements_id_fk" FOREIGN KEY ("to_id") REFERENCES "public"."requirements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_releases" ADD CONSTRAINT "requirement_releases_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_releases" ADD CONSTRAINT "requirement_releases_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_releases" ADD CONSTRAINT "requirement_releases_release_id_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."releases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirements" ADD CONSTRAINT "requirements_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirements" ADD CONSTRAINT "requirements_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirements" ADD CONSTRAINT "requirements_owner_member_id_members_id_fk" FOREIGN KEY ("owner_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirements" ADD CONSTRAINT "requirements_requester_member_id_members_id_fk" FOREIGN KEY ("requester_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirements" ADD CONSTRAINT "requirements_node_id_structure_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."structure_nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirements" ADD CONSTRAINT "requirements_iteration_id_iterations_id_fk" FOREIGN KEY ("iteration_id") REFERENCES "public"."iterations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirements" ADD CONSTRAINT "requirements_created_by_members_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "state_transitions" ADD CONSTRAINT "state_transitions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "state_transitions" ADD CONSTRAINT "state_transitions_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "state_transitions" ADD CONSTRAINT "state_transitions_actor_member_id_members_id_fk" FOREIGN KEY ("actor_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "structure_nodes" ADD CONSTRAINT "structure_nodes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "structure_nodes" ADD CONSTRAINT "structure_nodes_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "structure_nodes" ADD CONSTRAINT "structure_nodes_parent_id_structure_nodes_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."structure_nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_iteration_id_iterations_id_fk" FOREIGN KEY ("iteration_id") REFERENCES "public"."iterations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_member_id_members_id_fk" FOREIGN KEY ("assignee_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "blockers_requirement" ON "blockers" USING btree ("requirement_id");--> statement-breakpoint
CREATE UNIQUE INDEX "check_item_results_target_item" ON "check_item_results" USING btree ("target_type","target_id","item_key");--> statement-breakpoint
CREATE INDEX "check_item_signoffs_result" ON "check_item_signoffs" USING btree ("result_id");--> statement-breakpoint
CREATE INDEX "comments_target" ON "comments" USING btree ("target_type","target_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "entity_aliases_org_alias" ON "entity_aliases" USING btree ("org_id","alias");--> statement-breakpoint
CREATE UNIQUE INDEX "field_values_entity_option" ON "field_values" USING btree ("entity_id","field_id","option_id");--> statement-breakpoint
CREATE INDEX "field_values_option" ON "field_values" USING btree ("option_id");--> statement-breakpoint
CREATE INDEX "iterations_product" ON "iterations" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "releases_product" ON "releases" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "requirement_assignments_requirement" ON "requirement_assignments" USING btree ("requirement_id");--> statement-breakpoint
CREATE INDEX "requirement_assignments_member" ON "requirement_assignments" USING btree ("member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "requirement_relations_unique" ON "requirement_relations" USING btree ("from_id","to_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX "requirements_product_number" ON "requirements" USING btree ("product_id","number");--> statement-breakpoint
CREATE INDEX "requirements_product_state" ON "requirements" USING btree ("product_id","state_key");--> statement-breakpoint
CREATE INDEX "requirements_product_updated" ON "requirements" USING btree ("product_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "requirements_owner" ON "requirements" USING btree ("owner_member_id");--> statement-breakpoint
CREATE INDEX "requirements_iteration" ON "requirements" USING btree ("iteration_id");--> statement-breakpoint
CREATE INDEX "state_transitions_requirement" ON "state_transitions" USING btree ("requirement_id","at");--> statement-breakpoint
CREATE INDEX "tasks_requirement" ON "tasks" USING btree ("requirement_id");--> statement-breakpoint
CREATE INDEX "tasks_assignee" ON "tasks" USING btree ("assignee_member_id");--> statement-breakpoint
CREATE INDEX "tasks_iteration" ON "tasks" USING btree ("iteration_id");