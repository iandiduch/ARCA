CREATE TABLE "idempotency_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"resource" text DEFAULT 'invoices' NOT NULL,
	"status" text NOT NULL,
	"status_code" integer,
	"response_body" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"fiscal_identity_id" uuid NOT NULL,
	"point_of_sale_number" integer NOT NULL,
	"voucher_type" integer NOT NULL,
	"voucher_letter" text NOT NULL,
	"voucher_number" integer,
	"concept" integer DEFAULT 1 NOT NULL,
	"service_date_from" timestamp with time zone,
	"service_date_to" timestamp with time zone,
	"payment_due_date" timestamp with time zone,
	"issue_date" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"cae" text,
	"cae_expires_at" timestamp with time zone,
	"total_amount" numeric(14, 2) NOT NULL,
	"net_taxed_amount" numeric(14, 2) DEFAULT '0.00' NOT NULL,
	"net_untaxed_amount" numeric(14, 2) DEFAULT '0.00' NOT NULL,
	"exempt_amount" numeric(14, 2) DEFAULT '0.00' NOT NULL,
	"vat_amount" numeric(14, 2) DEFAULT '0.00' NOT NULL,
	"special_taxes_amount" numeric(14, 2) DEFAULT '0.00' NOT NULL,
	"currency" text DEFAULT 'PES' NOT NULL,
	"currency_rate" numeric(10, 4) DEFAULT '1.0000' NOT NULL,
	"customer_id" uuid,
	"customer_doc_type" integer DEFAULT 99 NOT NULL,
	"customer_doc_number" text DEFAULT '0' NOT NULL,
	"customer_name" text DEFAULT 'Consumidor Final' NOT NULL,
	"customer_tax_condition" integer,
	"customer_address" text,
	"notes" text,
	"afip_result" text,
	"afip_xml_request" text,
	"afip_xml_response" text,
	"afip_errors" jsonb,
	"afip_observations" jsonb,
	"afip_events" jsonb,
	"idempotency_key" text,
	"pos_sale_id" text,
	"qr_data" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"product_id" uuid,
	"internal_code" text,
	"description" text NOT NULL,
	"quantity" numeric(12, 4) NOT NULL,
	"unit_price" numeric(14, 4) NOT NULL,
	"discount" numeric(14, 4) DEFAULT '0.0000' NOT NULL,
	"vat_rate" numeric(5, 2) DEFAULT '21.00' NOT NULL,
	"vat_afip_code" integer DEFAULT 5 NOT NULL,
	"net_subtotal" numeric(14, 2) NOT NULL,
	"vat_subtotal" numeric(14, 2) NOT NULL,
	"total_subtotal" numeric(14, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_vat_subtotals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"vat_afip_code" integer NOT NULL,
	"vat_rate" numeric(5, 2) NOT NULL,
	"base_amount" numeric(14, 2) NOT NULL,
	"vat_amount" numeric(14, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_associated_vouchers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"associated_voucher_type" integer NOT NULL,
	"point_of_sale" integer NOT NULL,
	"voucher_number" integer NOT NULL,
	"cuit" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_fiscal_identity_id_fiscal_identities_id_fk" FOREIGN KEY ("fiscal_identity_id") REFERENCES "public"."fiscal_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_vat_subtotals" ADD CONSTRAINT "invoice_vat_subtotals_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_associated_vouchers" ADD CONSTRAINT "invoice_associated_vouchers_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_keys_tenant_key_unique_idx" ON "idempotency_keys" USING btree ("tenant_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_fiscal_unique_cbte_idx" ON "invoices" USING btree ("fiscal_identity_id","point_of_sale_number","voucher_type","voucher_number");--> statement-breakpoint
CREATE INDEX "invoices_tenant_status_idx" ON "invoices" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "invoices_tenant_created_at_idx" ON "invoices" USING btree ("tenant_id","created_at");