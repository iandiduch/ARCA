import { pgTable, uuid, integer, text, timestamp } from 'drizzle-orm/pg-core';
import { invoices } from './invoices.js';

export const invoiceAssociatedVouchers = pgTable('invoice_associated_vouchers', {
  id: uuid('id').primaryKey().defaultRandom(),
  invoiceId: uuid('invoice_id')
    .notNull()
    .references(() => invoices.id, { onDelete: 'cascade' }),
  associatedVoucherType: integer('associated_voucher_type').notNull(),
  pointOfSale: integer('point_of_sale').notNull(),
  voucherNumber: integer('voucher_number').notNull(),
  cuit: text('cuit'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
});

export type InvoiceAssociatedVoucher = typeof invoiceAssociatedVouchers.$inferSelect;
export type NewInvoiceAssociatedVoucher = typeof invoiceAssociatedVouchers.$inferInsert;
