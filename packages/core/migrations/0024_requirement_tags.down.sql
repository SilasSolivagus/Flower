-- 回滚 0024_requirement_tags。本文件不在 meta/_journal.json，migrate 不会执行它。
-- 删表会连带卸掉挂载（外键 ON DELETE CASCADE）。最后删掉 drizzle 迁移账本里 0024 那一行，才能再次 up。
DROP TABLE IF EXISTS "requirement_tag_links";
--> statement-breakpoint
DROP TABLE IF EXISTS "requirement_tags";
--> statement-breakpoint
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1792502400000;
