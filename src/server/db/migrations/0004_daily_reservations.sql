CREATE TABLE "daily_reservations" (
	"id" text PRIMARY KEY NOT NULL,
	"day" text NOT NULL,
	"tokens" integer NOT NULL,
	"state" text DEFAULT 'reserved' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);