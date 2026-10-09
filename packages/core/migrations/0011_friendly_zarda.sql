CREATE TABLE "entity_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"source_section" text,
	"target_type" text,
	"target_id" uuid,
	"target_section" text,
	"target_text" text NOT NULL,
	"context" text DEFAULT '' NOT NULL,
	"origin" text DEFAULT 'wikilink' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "task_seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "number" integer;--> statement-breakpoint
ALTER TABLE "entity_links" ADD CONSTRAINT "entity_links_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "entity_links_source" ON "entity_links" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "entity_links_target" ON "entity_links" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "entity_links_org_text" ON "entity_links" USING btree ("org_id","target_text");--> statement-breakpoint
CREATE UNIQUE INDEX "iterations_product_name" ON "iterations" USING btree ("product_id","name") WHERE "iterations"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_product_number" ON "tasks" USING btree ("product_id","number");--> statement-breakpoint
UPDATE "tasks" AS t SET "number" = n.rn
FROM (SELECT "id", row_number() OVER (PARTITION BY "product_id" ORDER BY "created_at", "id") AS rn FROM "tasks") AS n
WHERE n."id" = t."id";--> statement-breakpoint
UPDATE "products" AS p SET "task_seq" = coalesce((SELECT max(t."number") FROM "tasks" AS t WHERE t."product_id" = p."id"), 0);--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "number" SET NOT NULL;
