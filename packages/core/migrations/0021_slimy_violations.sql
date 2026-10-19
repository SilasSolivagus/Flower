CREATE TABLE "document_briefs" (
	"document_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"version" text DEFAULT 'v0.1' NOT NULL,
	"requester_member_id" uuid,
	"decider_member_id" uuid,
	"author_member_id" uuid,
	"participant_tag_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"related_links" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"gate_checks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"converted_document_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "documents_product_number";--> statement-breakpoint
ALTER TABLE "document_templates" ADD COLUMN "guidance" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "brief_seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "requirements" ADD COLUMN "brief_document_id" uuid;--> statement-breakpoint
ALTER TABLE "document_briefs" ADD CONSTRAINT "document_briefs_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_briefs" ADD CONSTRAINT "document_briefs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_briefs" ADD CONSTRAINT "document_briefs_requester_member_id_members_id_fk" FOREIGN KEY ("requester_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_briefs" ADD CONSTRAINT "document_briefs_decider_member_id_members_id_fk" FOREIGN KEY ("decider_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_briefs" ADD CONSTRAINT "document_briefs_author_member_id_members_id_fk" FOREIGN KEY ("author_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_briefs" ADD CONSTRAINT "document_briefs_converted_document_id_documents_id_fk" FOREIGN KEY ("converted_document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_briefs_converted" ON "document_briefs" USING btree ("converted_document_id");--> statement-breakpoint
ALTER TABLE "requirements" ADD CONSTRAINT "requirements_brief_document_id_documents_id_fk" FOREIGN KEY ("brief_document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "documents_product_brief_number" ON "documents" USING btree ("product_id","number") WHERE "documents"."kind" = 'brief';--> statement-breakpoint
CREATE INDEX "requirements_brief_document" ON "requirements" USING btree ("brief_document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_product_number" ON "documents" USING btree ("product_id","number") WHERE "documents"."kind" <> 'brief';