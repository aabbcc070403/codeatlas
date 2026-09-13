CREATE TABLE "evaluation_projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"evaluation_id" uuid NOT NULL,
	"project_id" text NOT NULL,
	"scan_id" uuid NOT NULL,
	"status" text NOT NULL,
	"metrics_json" jsonb NOT NULL,
	"latency_ms" integer NOT NULL,
	"token_total" integer NOT NULL,
	"provider_is_mock" boolean NOT NULL,
	"provider" text NOT NULL,
	"model_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "evaluation_projects" ADD CONSTRAINT "evaluation_projects_evaluation_id_evaluations_id_fk" FOREIGN KEY ("evaluation_id") REFERENCES "public"."evaluations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_projects" ADD CONSTRAINT "evaluation_projects_scan_id_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."scans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "evaluation_projects_eval_project_key" ON "evaluation_projects" USING btree ("evaluation_id","project_id");--> statement-breakpoint
CREATE INDEX "evaluation_projects_scan_id_idx" ON "evaluation_projects" USING btree ("scan_id");