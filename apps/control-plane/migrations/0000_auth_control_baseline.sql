CREATE TABLE "hook_receipts" (
	"event_id" text PRIMARY KEY NOT NULL,
	"hook_type" text NOT NULL,
	"identity_id" uuid NOT NULL,
	"flow_id" text NOT NULL,
	"session_id" text,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity_gates" (
	"identity_id" uuid PRIMARY KEY NOT NULL,
	"reset_required" boolean DEFAULT false NOT NULL,
	"reset_generation" integer DEFAULT 0 NOT NULL,
	"source" text NOT NULL,
	"reset_completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_gates_reset_generation_valid" CHECK ("identity_gates"."reset_generation" >= 0)
);
--> statement-breakpoint
CREATE TABLE "identity_source_aliases" (
	"source" text NOT NULL,
	"source_user_id" text NOT NULL,
	"identity_id" uuid NOT NULL,
	"email_sha256" text NOT NULL,
	"admission_scope" text NOT NULL,
	"state" text NOT NULL,
	"first_snapshot" text NOT NULL,
	"last_snapshot" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_source_aliases_pk" PRIMARY KEY("source","source_user_id"),
	CONSTRAINT "identity_source_aliases_email_hash_valid" CHECK ("identity_source_aliases"."email_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "identity_source_aliases_state_valid" CHECK ("identity_source_aliases"."state" in ('active', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "identity_source_memberships" (
	"source" text NOT NULL,
	"source_user_id" text NOT NULL,
	"admission_scope" text NOT NULL,
	"tenant_id" text NOT NULL,
	"identity_id" uuid NOT NULL,
	"role" text NOT NULL,
	"last_snapshot" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_source_memberships_pk" PRIMARY KEY("source","source_user_id","admission_scope","tenant_id"),
	CONSTRAINT "identity_source_memberships_tenant_valid" CHECK (length("identity_source_memberships"."tenant_id") between 1 and 200),
	CONSTRAINT "identity_source_memberships_role_valid" CHECK ("identity_source_memberships"."role" ~ '^[a-z][a-z0-9_-]{0,63}$')
);
--> statement-breakpoint
CREATE TABLE "identity_sync_batches" (
	"request_sha256" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"source" text NOT NULL,
	"source_snapshot" text NOT NULL,
	"expected_count" integer NOT NULL,
	"status" text NOT NULL,
	"response" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"last_error_code" text,
	CONSTRAINT "identity_sync_batches_hash_valid" CHECK ("identity_sync_batches"."request_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "identity_sync_batches_expected_count_valid" CHECK ("identity_sync_batches"."expected_count" between 1 and 500),
	CONSTRAINT "identity_sync_batches_status_valid" CHECK ("identity_sync_batches"."status" in ('running', 'completed', 'failed')),
	CONSTRAINT "identity_sync_batches_completion_valid" CHECK ((
        "identity_sync_batches"."status" = 'completed'
        and "identity_sync_batches"."completed_at" is not null
        and "identity_sync_batches"."response" is not null
        and "identity_sync_batches"."last_error_code" is null
      ) or "identity_sync_batches"."status" <> 'completed')
);
--> statement-breakpoint
CREATE TABLE "invitation_events" (
	"event_id" text NOT NULL,
	"invitation_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"outcome" text NOT NULL,
	"flow_id" text,
	"detail_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitation_events_pk" PRIMARY KEY("event_id","invitation_id")
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"identity_id" uuid,
	"normalized_email" text NOT NULL,
	"product" text NOT NULL,
	"invited_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"recovery_dispatched_at" timestamp with time zone,
	"idempotency_key" text NOT NULL,
	"request_fingerprint" char(64) NOT NULL,
	"state" text NOT NULL,
	"admission_preexisting" boolean DEFAULT false NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"processing_token" uuid,
	"processing_started_at" timestamp with time zone,
	"activation_requested_at" timestamp with time zone,
	"activated_at" timestamp with time zone,
	"expired_at" timestamp with time zone,
	"last_error_code" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_email_normalized" CHECK ("invitations"."normalized_email" = lower("invitations"."normalized_email")),
	CONSTRAINT "invitations_state_valid" CHECK ("invitations"."state" in ('pending_identity', 'identity_failed', 'pending_dispatch', 'dispatch_failed', 'dispatched', 'activation_pending', 'activation_failed', 'active', 'expired')),
	CONSTRAINT "invitations_attempt_count_valid" CHECK ("invitations"."attempt_count" >= 0),
	CONSTRAINT "invitations_processing_pair" CHECK (("invitations"."processing_token" is null) = ("invitations"."processing_started_at" is null))
);
--> statement-breakpoint
ALTER TABLE "identity_source_memberships" ADD CONSTRAINT "identity_source_memberships_alias_fk" FOREIGN KEY ("source","source_user_id") REFERENCES "public"."identity_source_aliases"("source","source_user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation_events" ADD CONSTRAINT "invitation_events_invitation_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."invitations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "identity_source_aliases_identity_idx" ON "identity_source_aliases" USING btree ("identity_id");--> statement-breakpoint
CREATE INDEX "identity_source_aliases_counterpart_idx" ON "identity_source_aliases" USING btree ("source_user_id","email_sha256","source");--> statement-breakpoint
CREATE INDEX "identity_source_memberships_identity_idx" ON "identity_source_memberships" USING btree ("identity_id","admission_scope");--> statement-breakpoint
CREATE INDEX "invitations_identity_idx" ON "invitations" USING btree ("identity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_idempotency_key_idx" ON "invitations" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "invitations_pending_activation_idx" ON "invitations" USING btree ("identity_id","product","state") WHERE "invitations"."state" in ('dispatched', 'activation_pending', 'activation_failed');