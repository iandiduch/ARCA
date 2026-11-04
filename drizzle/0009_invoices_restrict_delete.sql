ALTER TABLE "invoices" DROP CONSTRAINT "invoices_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "invoices" DROP CONSTRAINT "invoices_fiscal_identity_id_fiscal_identities_id_fk";
--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_fiscal_identity_id_fiscal_identities_id_fk" FOREIGN KEY ("fiscal_identity_id") REFERENCES "public"."fiscal_identities"("id") ON DELETE restrict ON UPDATE no action;