import { pgTable, uuid, text, integer, numeric, timestamp, jsonb, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';
import { fiscalIdentities } from './fiscal-identities.js';
import { customers } from './customers.js';

export const invoices = pgTable(
  'invoices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    fiscalIdentityId: uuid('fiscal_identity_id')
      .notNull()
      .references(() => fiscalIdentities.id, { onDelete: 'cascade' }),
    pointOfSaleNumber: integer('point_of_sale_number').notNull(),
    voucherType: integer('voucher_type').notNull(), // 1=Factura A, 6=Factura B, 11=Factura C, etc.
    voucherLetter: text('voucher_letter').notNull(), // 'A', 'B', 'C', 'M'
    voucherNumber: integer('voucher_number'), // Nro asignado por ARCA (null en DRAFT)
    concept: integer('concept').default(1).notNull(), // 1=Productos, 2=Servicios, 3=Productos y Servicios
    serviceDateFrom: timestamp('service_date_from', { withTimezone: true }),
    serviceDateTo: timestamp('service_date_to', { withTimezone: true }),
    paymentDueDate: timestamp('payment_due_date', { withTimezone: true }),
    issueDate: timestamp('issue_date', { withTimezone: true }).defaultNow().notNull(),
    status: text('status').default('DRAFT').notNull(), // 'DRAFT', 'PENDING', 'AUTHORIZED', 'REJECTED', 'PENDING_RECONCILIATION'
    cae: text('cae'),
    caeExpiresAt: timestamp('cae_expires_at', { withTimezone: true }),
    totalAmount: numeric('total_amount', { precision: 14, scale: 2 }).notNull(),
    netTaxedAmount: numeric('net_taxed_amount', { precision: 14, scale: 2 }).default('0.00').notNull(),
    netUntaxedAmount: numeric('net_untaxed_amount', { precision: 14, scale: 2 }).default('0.00').notNull(),
    exemptAmount: numeric('exempt_amount', { precision: 14, scale: 2 }).default('0.00').notNull(),
    vatAmount: numeric('vat_amount', { precision: 14, scale: 2 }).default('0.00').notNull(),
    specialTaxesAmount: numeric('special_taxes_amount', { precision: 14, scale: 2 }).default('0.00').notNull(),
    currency: text('currency').default('PES').notNull(),
    currencyRate: numeric('currency_rate', { precision: 10, scale: 4 }).default('1.0000').notNull(),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
    customerDocType: integer('customer_doc_type').default(99).notNull(), // 80=CUIT, 96=DNI, 99=CF
    customerDocNumber: text('customer_doc_number').default('0').notNull(),
    customerName: text('customer_name').default('Consumidor Final').notNull(),
    customerTaxCondition: integer('customer_tax_condition'), // 1=RI, 5=CF, 6=Monotributo, 4=Exento
    customerAddress: text('customer_address'),
    notes: text('notes'),
    afipResult: text('afip_result'), // 'A', 'R', 'P'
    afipXmlRequest: text('afip_xml_request'),
    afipXmlResponse: text('afip_xml_response'),
    afipErrors: jsonb('afip_errors'),
    afipObservations: jsonb('afip_observations'),
    afipEvents: jsonb('afip_events'),
    idempotencyKey: text('idempotency_key'),
    posSaleId: text('pos_sale_id'),
    qrData: text('qr_data'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    uniqueIndex('invoices_fiscal_unique_cbte_idx').on(
      table.fiscalIdentityId,
      table.pointOfSaleNumber,
      table.voucherType,
      table.voucherNumber
    ),
    index('invoices_tenant_status_idx').on(table.tenantId, table.status),
    index('invoices_tenant_created_at_idx').on(table.tenantId, table.createdAt)
  ]
);

export type Invoice = typeof invoices.$inferSelect;
export type NewInvoice = typeof invoices.$inferInsert;
