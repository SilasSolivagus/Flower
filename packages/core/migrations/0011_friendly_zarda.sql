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
-- 加唯一索引前先处理已有的重名：同一产品内未删除的常规迭代按 created_at、id 排序，第 2 个起改名为「名称（N）」，N 取未被占用的最小值（从 2 开始）
DO $$
DECLARE
  r record;
  n integer;
  candidate text;
BEGIN
  FOR r IN
    SELECT d.id, d.product_id, d.name
    FROM (
      SELECT id, product_id, name, row_number() OVER (PARTITION BY product_id, name ORDER BY created_at, id) AS rn
      FROM iterations
      WHERE deleted_at IS NULL AND product_id IS NOT NULL
    ) AS d
    WHERE d.rn > 1
    ORDER BY d.product_id, d.name, d.rn
  LOOP
    n := 2;
    LOOP
      candidate := r.name || '（' || n || '）';
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM iterations WHERE product_id = r.product_id AND deleted_at IS NULL AND name = candidate
      );
      n := n + 1;
    END LOOP;
    UPDATE iterations SET name = candidate WHERE id = r.id;
  END LOOP;
END
$$;--> statement-breakpoint
CREATE UNIQUE INDEX "iterations_product_name" ON "iterations" USING btree ("product_id","name") WHERE "iterations"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_product_number" ON "tasks" USING btree ("product_id","number");--> statement-breakpoint
UPDATE "tasks" AS t SET "number" = n.rn
FROM (SELECT "id", row_number() OVER (PARTITION BY "product_id" ORDER BY "created_at", "id") AS rn FROM "tasks") AS n
WHERE n."id" = t."id";--> statement-breakpoint
UPDATE "products" AS p SET "task_seq" = coalesce((SELECT max(t."number") FROM "tasks" AS t WHERE t."product_id" = p."id"), 0);--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "number" SET NOT NULL;
