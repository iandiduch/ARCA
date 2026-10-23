import { pgTable, uuid, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';

export const fiscalIdentities = pgTable(
  'fiscal_identities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    cuit: text('cuit').notNull(), // 11 dígitos numéricos
    businessName: text('business_name').notNull(),
    environment: text('environment').default('homologation').notNull(), // 'homologation' | 'production'
    taxCondition: text('tax_condition').default('RESPONSABLE_MONOTRIBUTO').notNull(),
    grossIncomeNumber: text('gross_income_number'), // Ingresos Brutos
    activityStartDate: text('activity_start_date'), // YYYY-MM-DD
    connectionType: text('connection_type').default('DELEGATION').notNull(), // 'DELEGATION' | 'OWN_CERTIFICATE'
    status: text('status').default('NOT_STARTED').notNull(),
    statusReason: text('status_reason'),
    lastValidatedAt: timestamp('last_validated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    uniqueIndex('fiscal_identities_tenant_cuit_env_idx').on(table.tenantId, table.cuit, table.environment)
  ]
);

export type FiscalIdentity = typeof fiscalIdentities.$inferSelect;
export type NewFiscalIdentity = typeof fiscalIdentities.$inferInsert;
