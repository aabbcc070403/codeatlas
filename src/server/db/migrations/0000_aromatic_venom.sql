CREATE TABLE "chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"text" text NOT NULL,
	"heading" text DEFAULT '' NOT NULL,
	"start_line" integer NOT NULL,
	"end_line" integer NOT NULL,
	"embedding" vector(1536),
	"embedding_model" text,
	"index_version" integer DEFAULT 1 NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_usage" (
	"day" text PRIMARY KEY NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid,
	"builtin_key" text,
	"version" integer DEFAULT 1 NOT NULL,
	"content_hash" text NOT NULL,
	"source_url" text,
	"title" text NOT NULL,
	"category" text NOT NULL,
	"is_builtin" boolean DEFAULT false NOT NULL,
	"index_status" text DEFAULT 'pending' NOT NULL,
	"index_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evaluations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dataset_version" text NOT NULL,
	"config_json" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"metrics_json" jsonb,
	"artifact_path" text,
	"error_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"path" text NOT NULL,
	"content_hash" text NOT NULL,
	"storage_key" text NOT NULL,
	"language" text NOT NULL,
	"line_count" integer DEFAULT 0 NOT NULL,
	"parse_status" text DEFAULT 'pending' NOT NULL,
	"redacted_ranges" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scan_id" uuid NOT NULL,
	"rule_id" text,
	"fingerprint" text NOT NULL,
	"draft_json" jsonb NOT NULL,
	"source" text NOT NULL,
	"evidence_status" text DEFAULT 'valid' NOT NULL,
	"feedback" text DEFAULT 'unreviewed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"target_id" uuid NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"lease_owner" text,
	"lease_generation" integer DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone,
	"attempt" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancel_requested_at" timestamp with time zone,
	"last_error" text,
	"payload_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"finding_id" uuid NOT NULL,
	"role" text NOT NULL,
	"text" text NOT NULL,
	"citations_json" jsonb DEFAULT '[]'::jsonb,
	"usage_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"finding_id" uuid NOT NULL,
	"base_file_hash" text NOT NULL,
	"edits_json" jsonb NOT NULL,
	"diff_text" text NOT NULL,
	"validation_json" jsonb NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid,
	"name" text NOT NULL,
	"is_preset" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scan_citations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scan_id" uuid NOT NULL,
	"chunk_id" uuid,
	"version" integer NOT NULL,
	"text_snapshot" text NOT NULL,
	"source_url" text,
	"title" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scan_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"scan_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"payload_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"stage" text DEFAULT 'ingest' NOT NULL,
	"config_json" jsonb NOT NULL,
	"rule_version" text NOT NULL,
	"prompt_version" text NOT NULL,
	"model_id" text,
	"coverage_json" jsonb,
	"usage_json" jsonb,
	"risk_json" jsonb,
	"error_text" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"role" text DEFAULT 'demo' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"content_hash" text NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"file_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"structure_json" jsonb,
	"skipped_json" jsonb DEFAULT '[]'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scan_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"tool_name" text NOT NULL,
	"input_summary" text NOT NULL,
	"result_summary" text NOT NULL,
	"elapsed_ms" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'ok' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_snapshot_id_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_scan_id_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."scans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_finding_id_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."findings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patches" ADD CONSTRAINT "patches_finding_id_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."findings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_citations" ADD CONSTRAINT "scan_citations_scan_id_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."scans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_events" ADD CONSTRAINT "scan_events_scan_id_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."scans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scans" ADD CONSTRAINT "scans_snapshot_id_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_scan_id_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."scans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chunks_document_id_idx" ON "chunks" USING btree ("document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_builtin_key_key" ON "documents" USING btree ("builtin_key");--> statement-breakpoint
CREATE INDEX "documents_project_id_idx" ON "documents" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "documents_is_builtin_idx" ON "documents" USING btree ("is_builtin");--> statement-breakpoint
CREATE UNIQUE INDEX "files_snapshot_path_key" ON "files" USING btree ("snapshot_id","path");--> statement-breakpoint
CREATE INDEX "files_snapshot_id_idx" ON "files" USING btree ("snapshot_id");--> statement-breakpoint
CREATE UNIQUE INDEX "findings_scan_fingerprint_key" ON "findings" USING btree ("scan_id","fingerprint");--> statement-breakpoint
CREATE INDEX "findings_scan_id_idx" ON "findings" USING btree ("scan_id");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_kind_target_key" ON "jobs" USING btree ("kind","target_id");--> statement-breakpoint
CREATE INDEX "jobs_state_available_idx" ON "jobs" USING btree ("state","available_at");--> statement-breakpoint
CREATE INDEX "messages_finding_id_idx" ON "messages" USING btree ("finding_id");--> statement-breakpoint
CREATE INDEX "patches_finding_id_idx" ON "patches" USING btree ("finding_id");--> statement-breakpoint
CREATE INDEX "projects_session_id_idx" ON "projects" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "scan_citations_scan_id_idx" ON "scan_citations" USING btree ("scan_id");--> statement-breakpoint
CREATE INDEX "scan_events_scan_id_idx" ON "scan_events" USING btree ("scan_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "scans_snapshot_idempotency_key" ON "scans" USING btree ("snapshot_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "scans_snapshot_id_idx" ON "scans" USING btree ("snapshot_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "snapshots_project_id_idx" ON "snapshots" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "tool_calls_scan_id_idx" ON "tool_calls" USING btree ("scan_id");