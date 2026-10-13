CREATE TABLE "member_notification_prefs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"in_app" boolean NOT NULL,
	"wecom" boolean NOT NULL,
	"email" boolean NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member_notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"event_id" uuid,
	"kind" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"url" text NOT NULL,
	"actor_member_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "notification_cursors" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"last_occurred_at" timestamp with time zone,
	"last_event_id" uuid,
	"failing_event_id" uuid,
	"failures" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"source" text NOT NULL,
	"muted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wecom_apps" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"corp_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"secret" text NOT NULL,
	"secret_hint" text NOT NULL,
	"bind_enabled" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wecom_bind_states" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"state_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification_deliveries" DROP CONSTRAINT "notification_deliveries_source";--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "wecom_userid" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "personal_email_channel_id" uuid;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "personal_channel_id" uuid;--> statement-breakpoint
ALTER TABLE "member_notification_prefs" ADD CONSTRAINT "member_notification_prefs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_notification_prefs" ADD CONSTRAINT "member_notification_prefs_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_notifications" ADD CONSTRAINT "member_notifications_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_notifications" ADD CONSTRAINT "member_notifications_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_notifications" ADD CONSTRAINT "member_notifications_event_id_domain_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."domain_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_notifications" ADD CONSTRAINT "member_notifications_actor_member_id_members_id_fk" FOREIGN KEY ("actor_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_cursors" ADD CONSTRAINT "notification_cursors_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wecom_apps" ADD CONSTRAINT "wecom_apps_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wecom_bind_states" ADD CONSTRAINT "wecom_bind_states_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wecom_bind_states" ADD CONSTRAINT "wecom_bind_states_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "member_notification_prefs_member_kind" ON "member_notification_prefs" USING btree ("member_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "member_notifications_member_event_kind" ON "member_notifications" USING btree ("member_id","event_id","kind") WHERE "member_notifications"."event_id" is not null;--> statement-breakpoint
CREATE INDEX "member_notifications_member_created" ON "member_notifications" USING btree ("member_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "member_notifications_unread" ON "member_notifications" USING btree ("member_id") WHERE "member_notifications"."read_at" is null;--> statement-breakpoint
CREATE INDEX "member_notifications_subject" ON "member_notifications" USING btree ("member_id","subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "member_notifications_read_at" ON "member_notifications" USING btree ("read_at") WHERE "member_notifications"."read_at" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_member_subject" ON "subscriptions" USING btree ("member_id","subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "subscriptions_subject" ON "subscriptions" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wecom_apps_org" ON "wecom_apps" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wecom_bind_states_hash" ON "wecom_bind_states" USING btree ("state_hash");--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_personal_email_channel_id_notification_channels_id_fk" FOREIGN KEY ("personal_email_channel_id") REFERENCES "public"."notification_channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_personal_channel_id_notification_channels_id_fk" FOREIGN KEY ("personal_channel_id") REFERENCES "public"."notification_channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "members_org_wecom" ON "members" USING btree ("org_id","wecom_userid") WHERE "members"."wecom_userid" is not null;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_source" CHECK (("notification_deliveries"."kind" = 'rule' and "notification_deliveries"."rule_id" is not null and "notification_deliveries"."schedule_id" is null) or ("notification_deliveries"."kind" = 'schedule' and "notification_deliveries"."schedule_id" is not null and "notification_deliveries"."rule_id" is null) or ("notification_deliveries"."kind" in ('test', 'personal') and "notification_deliveries"."rule_id" is null and "notification_deliveries"."schedule_id" is null));