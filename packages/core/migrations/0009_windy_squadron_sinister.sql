CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"filename" text NOT NULL,
	"mime" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"width" integer,
	"height" integer,
	"uploader_member_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attachments_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
CREATE TABLE "document_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"summary" text,
	"author_member_id" uuid,
	"merged_from_document_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_templates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"product_id" uuid,
	"kind" text DEFAULT 'change' NOT NULL,
	"name" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"sections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"kind" text DEFAULT 'change' NOT NULL,
	"source" text NOT NULL,
	"title" text NOT NULL,
	"owner_member_id" uuid,
	"template_id" uuid,
	"node_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"current_revision_id" uuid,
	"external_url" text,
	"external_url_key" text,
	"external_provider" text,
	"version" integer DEFAULT 1 NOT NULL,
	"legacy_key" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "documents_external" CHECK ("documents"."source" <> 'external' or ("documents"."external_url" is not null and "documents"."external_url_key" is not null and "documents"."current_revision_id" is null))
);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "document_seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploader_member_id_members_id_fk" FOREIGN KEY ("uploader_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_revisions" ADD CONSTRAINT "document_revisions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_revisions" ADD CONSTRAINT "document_revisions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_revisions" ADD CONSTRAINT "document_revisions_author_member_id_members_id_fk" FOREIGN KEY ("author_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_templates" ADD CONSTRAINT "document_templates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_templates" ADD CONSTRAINT "document_templates_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_owner_member_id_members_id_fk" FOREIGN KEY ("owner_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_template_id_document_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."document_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_node_id_structure_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."structure_nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_current_revision_id_document_revisions_id_fk" FOREIGN KEY ("current_revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_created_by_members_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_target" ON "attachments" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_revisions_doc_version" ON "document_revisions" USING btree ("document_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "document_templates_org_name" ON "document_templates" USING btree ("org_id","kind","name") WHERE "document_templates"."product_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "document_templates_product_name" ON "document_templates" USING btree ("product_id","kind","name") WHERE "document_templates"."product_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "documents_product_number" ON "documents" USING btree ("product_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_product_url" ON "documents" USING btree ("product_id","external_url_key") WHERE "documents"."external_url_key" is not null and "documents"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "documents_product_updated" ON "documents" USING btree ("product_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "requirements" ADD CONSTRAINT "requirements_change_document_id_documents_id_fk" FOREIGN KEY ("change_document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "requirements_change_document" ON "requirements" USING btree ("change_document_id");