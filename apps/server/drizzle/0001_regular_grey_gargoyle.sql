CREATE TABLE "model_catalog" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"runtime" varchar(24) NOT NULL,
	"name" varchar(200) NOT NULL,
	"vendor" varchar(64) NOT NULL,
	"context_length" integer DEFAULT 0 NOT NULL,
	"price_prompt_per_m" numeric(12, 4),
	"price_completion_per_m" numeric(12, 4),
	"supports_tools" boolean DEFAULT false NOT NULL,
	"supports_reasoning" boolean DEFAULT false NOT NULL,
	"featured" boolean DEFAULT false NOT NULL,
	"dev_capable" boolean DEFAULT false NOT NULL,
	"released_at" timestamp with time zone,
	"refreshed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"hidden_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "model" SET DATA TYPE varchar(128);--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "runtime" varchar(24) DEFAULT 'claude-code' NOT NULL;--> statement-breakpoint
CREATE INDEX "model_catalog_featured_idx" ON "model_catalog" USING btree ("featured");--> statement-breakpoint
CREATE INDEX "model_catalog_vendor_idx" ON "model_catalog" USING btree ("vendor");