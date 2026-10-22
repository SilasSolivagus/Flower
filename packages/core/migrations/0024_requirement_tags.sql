-- 需求标签（M4-014）：组织级字典 + 需求多对多。不改已有表。
CREATE TABLE "requirement_tags" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "requirement_tags" ADD CONSTRAINT "requirement_tags_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "requirement_tags_org_lower_name" ON "requirement_tags" USING btree ("org_id",lower("name"));
--> statement-breakpoint
CREATE TABLE "requirement_tag_links" (
	"org_id" uuid NOT NULL,
	"requirement_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	CONSTRAINT "requirement_tag_links_requirement_id_tag_id_pk" PRIMARY KEY("requirement_id","tag_id")
);
--> statement-breakpoint
ALTER TABLE "requirement_tag_links" ADD CONSTRAINT "requirement_tag_links_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "requirement_tag_links" ADD CONSTRAINT "requirement_tag_links_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "requirement_tag_links" ADD CONSTRAINT "requirement_tag_links_tag_id_requirement_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."requirement_tags"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE requirement_tags ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON requirement_tags
  USING (current_setting('app.scope', true) = 'system'
         OR org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.scope', true) = 'system'
         OR org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE requirement_tag_links ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON requirement_tag_links
  USING (current_setting('app.scope', true) = 'system'
         OR org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.scope', true) = 'system'
         OR org_id = nullif(current_setting('app.org_id', true), '')::uuid);
