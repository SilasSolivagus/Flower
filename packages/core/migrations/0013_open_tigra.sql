CREATE TABLE "document_affected_nodes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"change_type" text NOT NULL,
	"source_sections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"merge_status" text DEFAULT 'pending' NOT NULL,
	"merged_revision_id" uuid,
	"merged_by" uuid,
	"merged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document_affected_nodes" ADD CONSTRAINT "document_affected_nodes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_affected_nodes" ADD CONSTRAINT "document_affected_nodes_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_affected_nodes" ADD CONSTRAINT "document_affected_nodes_node_id_structure_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."structure_nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_affected_nodes" ADD CONSTRAINT "document_affected_nodes_merged_revision_id_document_revisions_id_fk" FOREIGN KEY ("merged_revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_affected_nodes" ADD CONSTRAINT "document_affected_nodes_merged_by_members_id_fk" FOREIGN KEY ("merged_by") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "document_affected_nodes_doc_node" ON "document_affected_nodes" USING btree ("document_id","node_id");--> statement-breakpoint
CREATE INDEX "document_affected_nodes_node" ON "document_affected_nodes" USING btree ("node_id");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_module_node" ON "documents" USING btree ("node_id") WHERE "documents"."kind" = 'module' and "documents"."deleted_at" is null;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_kind_node" CHECK (("documents"."kind" = 'module') = ("documents"."node_id" is not null));