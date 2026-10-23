import { pgTable, uuid, text, numeric, integer, timestamp } from 'drizzle-orm/pg-core';
import { invoices } from './invoices.js';
import { products } from './products.js';

export const invoiceItems = pgTable('invoice_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  invoiceId: uuid('invoice_id')
    .notNull()
    .references(() => invoices.id, { onDelete: 'cascade' }),
  productId: uuid('product_id').references(() => products.id, { onDelete: 'set null' }),
  internalCode: text('internal_code'),
  description: text('description').notNull(),
  quantity: numeric('quantity', { precision: 12, scale: 4 }).notNull(),
  unitPrice: numeric('unit_price', { precision: 14, scale: 4 }).notNull(),
  discount: numeric('discount', { precision: 14, scale: 4 }).default('0.0000').notNull(),
  vatRate: numeric('vat_rate', { precision: 5, scale: 2 }).default('21.00').notNull(),
  vatAfipCode: integer('vat_afip_code').default(5).notNull(),
  netSubtotal: numeric('net_subtotal', { precision: 14, scale: 2 }).notNull(),
  vatSubtotal: numeric('vat_subtotal', { precision: 14, scale: 2 }).notNull(),
  totalSubtotal: numeric('total_subtotal', { precision: 14, scale: 2 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
});

export type InvoiceItem = typeof invoiceItems.$inferSelect;
export type NewInvoiceItem = typeof invoiceItems.$inferInsert;
