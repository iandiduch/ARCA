import { pgTable, uuid, text, integer, boolean, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';

export const customers = pgTable(
  'customers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(), // Razón Social o Nombre y Apellido
    documentType: text('document_type').default('DNI').notNull(), // CUIT, CUIL, DNI, PASAPORTE, OTRO
    documentTypeCode: integer('document_type_code').default(96).notNull(), // Código oficial AFIP (80, 86, 96, etc.)
    documentNumber: text('document_number').notNull(), // Número limpio sin guiones
    fiscalCondition: text('fiscal_condition').default('CONSUMIDOR_FINAL').notNull(),
    fiscalConditionCode: integer('fiscal_condition_code').default(5).notNull(), // Código AFIP (1, 5, 6, etc.)
    email: text('email'),
    phone: text('phone'),
    address: text('address'),
    active: boolean('active').default(true).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    uniqueIndex('customers_tenant_doc_unique_idx').on(table.tenantId, table.documentType, table.documentNumber)
  ]
);

export type Customer = typeof customers.$inferSelect;
export type NewCustomer = typeof customers.$inferInsert;
