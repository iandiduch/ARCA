CREATE INDEX "invoice_items_invoice_id_idx" ON "invoice_items" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "invoice_vat_subtotals_invoice_id_idx" ON "invoice_vat_subtotals" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "invoice_associated_vouchers_invoice_id_idx" ON "invoice_associated_vouchers" USING btree ("invoice_id");