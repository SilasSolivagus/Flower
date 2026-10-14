CREATE TABLE "progress_updates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"requirement_id" uuid,
	"work_item_id" uuid,
	"body" text NOT NULL,
	"next_step" text,
	"follower_member_id" uuid,
	"author_member_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "progress_updates_subject" CHECK (("progress_updates"."requirement_id" is null) <> ("progress_updates"."work_item_id" is null))
);
--> statement-breakpoint
CREATE TABLE "work_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"product_id" uuid,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"owner_member_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"started_on" date,
	"expected_date" date,
	"done_at" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"pause_reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "blockers" ALTER COLUMN "requirement_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "blockers" ADD COLUMN "work_item_id" uuid;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "work_item_seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "requirements" ADD COLUMN "tracked_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "requirements" ADD COLUMN "tracking_opted_out" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "requirements" ADD COLUMN "expected_date" date;--> statement-breakpoint
ALTER TABLE "requirements" ADD COLUMN "paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "requirements" ADD COLUMN "pause_reason" text;--> statement-breakpoint
ALTER TABLE "progress_updates" ADD CONSTRAINT "progress_updates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "progress_updates" ADD CONSTRAINT "progress_updates_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "progress_updates" ADD CONSTRAINT "progress_updates_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "progress_updates" ADD CONSTRAINT "progress_updates_follower_member_id_members_id_fk" FOREIGN KEY ("follower_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "progress_updates" ADD CONSTRAINT "progress_updates_author_member_id_members_id_fk" FOREIGN KEY ("author_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_owner_member_id_members_id_fk" FOREIGN KEY ("owner_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_created_by_members_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "progress_updates_requirement" ON "progress_updates" USING btree ("requirement_id","created_at");--> statement-breakpoint
CREATE INDEX "progress_updates_work_item" ON "progress_updates" USING btree ("work_item_id","created_at");--> statement-breakpoint
CREATE INDEX "progress_updates_follower" ON "progress_updates" USING btree ("follower_member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "work_items_org_number" ON "work_items" USING btree ("org_id","number");--> statement-breakpoint
CREATE INDEX "work_items_owner" ON "work_items" USING btree ("owner_member_id");--> statement-breakpoint
CREATE INDEX "work_items_product" ON "work_items" USING btree ("product_id");--> statement-breakpoint
ALTER TABLE "blockers" ADD CONSTRAINT "blockers_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "blockers_work_item" ON "blockers" USING btree ("work_item_id");--> statement-breakpoint
ALTER TABLE "blockers" ADD CONSTRAINT "blockers_subject" CHECK (("blockers"."requirement_id" is null) <> ("blockers"."work_item_id" is null));