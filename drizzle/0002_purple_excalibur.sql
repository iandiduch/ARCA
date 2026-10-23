CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"document_type" text DEFAULT 'DNI' NOT NULL,
	"document_type_code" integer DEFAULT 96 NOT NULL,
	"document_number" text NOT NULL,
	"fiscal_condition" text DEFAULT 'CONSUMIDOR_FINAL' NOT NULL,
	"fiscal_condition_code" integer DEFAULT 5 NOT NULL,
	"email" text,
	"phone" text,
	"address" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"internal_code" text,
	"barcode" text,
	"name" text NOT NULL,
	"description" text,
	"concept_type" integer DEFAULT 1 NOT NULL,
	"unit_measure" text DEFAULT 'UNIDAD' NOT NULL,
	"unit_measure_code" integer DEFAULT 7 NOT NULL,
	"cost_price" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"sale_price" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"iva_rate" numeric(5, 2) DEFAULT '21.00' NOT NULL,
	"iva_code" integer DEFAULT 5 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customers_tenant_doc_unique_idx" ON "customers" USING btree ("tenant_id","document_type","document_number");--> statement-breakpoint
CREATE UNIQUE INDEX "products_tenant_internal_code_unique_idx" ON "products" USING btree ("tenant_id","internal_code");