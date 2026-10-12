CREATE TABLE "message_templates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"format" text NOT NULL,
	"body" text NOT NULL,
	"builtin" boolean DEFAULT false NOT NULL,
	"builtin_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_templates_builtin" CHECK ("message_templates"."builtin" = ("message_templates"."builtin_key" is not null))
);
--> statement-breakpoint
CREATE TABLE "notification_channels" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"group_label" text,
	"config" text NOT NULL,
	"config_hint" text NOT NULL,
	"rate_limit_per_min" integer NOT NULL,
	"allowed_product_ids" uuid[] DEFAULT '{}' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_channels_rate" CHECK ("notification_channels"."rate_limit_per_min" between 1 and 600)
);
--> statement-breakpoint
CREATE TABLE "notification_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"rule_id" uuid,
	"schedule_id" uuid,
	"run_id" uuid,
	"channel_id" uuid NOT NULL,
	"event_id" uuid,
	"payload" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"response" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"legacy_key" text,
	CONSTRAINT "notification_deliveries_source" CHECK (("notification_deliveries"."kind" = 'rule' and "notification_deliveries"."rule_id" is not null and "notification_deliveries"."schedule_id" is null) or ("notification_deliveries"."kind" = 'schedule' and "notification_deliveries"."schedule_id" is not null and "notification_deliveries"."rule_id" is null) or ("notification_deliveries"."kind" = 'test' and "notification_deliveries"."rule_id" is null and "notification_deliveries"."schedule_id" is null))
);
--> statement-breakpoint
CREATE TABLE "notification_digest_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"schedule_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "notification_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"name" text NOT NULL,
	"event_types" text[] NOT NULL,
	"filter" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"channel_ids" uuid[] DEFAULT '{}' NOT NULL,
	"template_id" uuid,
	"mode" text DEFAULT 'immediate' NOT NULL,
	"digest_schedule_id" uuid,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_rules_digest" CHECK (("notification_rules"."mode" = 'digest') = ("notification_rules"."digest_schedule_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "notification_schedules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"product_id" uuid,
	"name" text NOT NULL,
	"cron" text NOT NULL,
	"timezone" text DEFAULT 'Asia/Shanghai' NOT NULL,
	"source" text NOT NULL,
	"source_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"channel_ids" uuid[] DEFAULT '{}' NOT NULL,
	"template_id" uuid,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"fail_threshold" integer DEFAULT 1 NOT NULL,
	"alert_state" text DEFAULT 'normal' NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_schedules_threshold" CHECK ("notification_schedules"."fail_threshold" between 1 and 10)
);
--> statement-breakpoint
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_channels" ADD CONSTRAINT "notification_channels_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_rule_id_notification_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."notification_rules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_schedule_id_notification_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."notification_schedules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_channel_id_notification_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."notification_channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_event_id_domain_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."domain_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_digest_items" ADD CONSTRAINT "notification_digest_items_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_digest_items" ADD CONSTRAINT "notification_digest_items_rule_id_notification_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."notification_rules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_digest_items" ADD CONSTRAINT "notification_digest_items_schedule_id_notification_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."notification_schedules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_digest_items" ADD CONSTRAINT "notification_digest_items_event_id_domain_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."domain_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_rules" ADD CONSTRAINT "notification_rules_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_rules" ADD CONSTRAINT "notification_rules_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_rules" ADD CONSTRAINT "notification_rules_template_id_message_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."message_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_rules" ADD CONSTRAINT "notification_rules_digest_schedule_id_notification_schedules_id_fk" FOREIGN KEY ("digest_schedule_id") REFERENCES "public"."notification_schedules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_schedules" ADD CONSTRAINT "notification_schedules_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_schedules" ADD CONSTRAINT "notification_schedules_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_schedules" ADD CONSTRAINT "notification_schedules_template_id_message_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."message_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "message_templates_org_name" ON "message_templates" USING btree ("org_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "message_templates_org_builtin" ON "message_templates" USING btree ("org_id","builtin_key") WHERE "message_templates"."builtin_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_channels_org_name" ON "notification_channels" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "notification_deliveries_due" ON "notification_deliveries" USING btree ("next_attempt_at") WHERE "notification_deliveries"."status" in ('pending', 'failed', 'sending');--> statement-breakpoint
CREATE INDEX "notification_deliveries_channel_sent" ON "notification_deliveries" USING btree ("channel_id","sent_at");--> statement-breakpoint
CREATE INDEX "notification_deliveries_org_created" ON "notification_deliveries" USING btree ("org_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notification_deliveries_run" ON "notification_deliveries" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_digest_items_rule_event" ON "notification_digest_items" USING btree ("rule_id","event_id");--> statement-breakpoint
CREATE INDEX "notification_digest_items_open" ON "notification_digest_items" USING btree ("schedule_id","created_at") WHERE "notification_digest_items"."consumed_at" is null;--> statement-breakpoint
CREATE INDEX "notification_digest_items_run" ON "notification_digest_items" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "notification_rules_product" ON "notification_rules" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "notification_schedules_product" ON "notification_schedules" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "notification_schedules_due" ON "notification_schedules" USING btree ("next_run_at") WHERE "notification_schedules"."enabled";