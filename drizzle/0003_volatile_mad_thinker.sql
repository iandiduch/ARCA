CREATE TABLE "fiscal_certificates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fiscal_identity_id" uuid NOT NULL,
	"encrypted_private_key" text NOT NULL,
	"private_key_iv" text NOT NULL,
	"private_key_auth_tag" text NOT NULL,
	"csr" text,
	"certificate" text,
	"certificate_fingerprint" text,
	"valid_from" timestamp with time zone,
	"valid_to" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fiscal_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"cuit" text NOT NULL,
	"business_name" text NOT NULL,
	"environment" text DEFAULT 'homologation' NOT NULL,
	"tax_condition" text DEFAULT 'RESPONSABLE_MONOTRIBUTO' NOT NULL,
	"gross_income_number" text,
	"activity_start_date" text,
	"connection_type" text DEFAULT 'DELEGATION' NOT NULL,
	"status" text DEFAULT 'NOT_STARTED' NOT NULL,
	"status_reason" text,
	"last_validated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "points_of_sale" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fiscal_identity_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"type" text DEFAULT 'ELECTRONIC' NOT NULL,
	"description" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wsaa_access_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fiscal_identity_id" uuid NOT NULL,
	"service" text DEFAULT 'wsfe' NOT NULL,
	"environment" text DEFAULT 'homologation' NOT NULL,
	"token" text NOT NULL,
	"sign" text NOT NULL,
	"generation_time" timestamp with time zone NOT NULL,
	"expiration_time" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fiscal_certificates" ADD CONSTRAINT "fiscal_certificates_fiscal_identity_id_fiscal_identities_id_fk" FOREIGN KEY ("fiscal_identity_id") REFERENCES "public"."fiscal_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_identities" ADD CONSTRAINT "fiscal_identities_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "points_of_sale" ADD CONSTRAINT "points_of_sale_fiscal_identity_id_fiscal_identities_id_fk" FOREIGN KEY ("fiscal_identity_id") REFERENCES "public"."fiscal_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wsaa_access_tickets" ADD CONSTRAINT "wsaa_access_tickets_fiscal_identity_id_fiscal_identities_id_fk" FOREIGN KEY ("fiscal_identity_id") REFERENCES "public"."fiscal_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fiscal_identities_tenant_cuit_env_idx" ON "fiscal_identities" USING btree ("tenant_id","cuit","environment");--> statement-breakpoint
CREATE UNIQUE INDEX "points_of_sale_identity_number_idx" ON "points_of_sale" USING btree ("fiscal_identity_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "wsaa_tickets_identity_service_env_idx" ON "wsaa_access_tickets" USING btree ("fiscal_identity_id","service","environment");