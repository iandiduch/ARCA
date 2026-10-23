import { pgTable, uuid, numeric, integer, timestamp } from 'drizzle-orm/pg-core';
import { invoices } from './invoices.js';

export const invoiceVatSubtotals = pgTable('invoice_vat_subtotals', {
  id: uuid('id').primaryKey().defaultRandom(),
  invoiceId: uuid('invoice_id')
    .notNull()
    .references(() => invoices.id, { onDelete: 'cascade' }),
  vatAfipCode: integer('vat_afip_code').notNull(), // 3=0%, 4=10.5%, 5=21%, 6=27%
  vatRate: numeric('vat_rate', { precision: 5, scale: 2 }).notNull(),
  baseAmount: numeric('base_amount', { precision: 14, scale: 2 }).notNull(),
  vatAmount: numeric('vat_amount', { precision: 14, scale: 2 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
});

export type InvoiceVatSubtotal = typeof invoiceVatSubtotals.$inferSelect;
export type NewInvoiceVatSubtotal = typeof invoiceVatSubtotals.$inferInsert;
