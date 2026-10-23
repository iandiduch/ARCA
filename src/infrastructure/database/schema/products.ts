import { pgTable, uuid, text, integer, numeric, boolean, timestamp, jsonb, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';

export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    internalCode: text('internal_code'), // SKU o código interno de inventario
    barcode: text('barcode'), // Código de barras para lector de POS
    name: text('name').notNull(),
    description: text('description'),
    conceptType: integer('concept_type').default(1).notNull(), // 1: Productos, 2: Servicios, 3: Ambos
    unitMeasure: text('unit_measure').default('UNIDAD').notNull(),
    unitMeasureCode: integer('unit_measure_code').default(7).notNull(), // AFIP 07 = Unidades
    costPrice: numeric('cost_price', { precision: 12, scale: 2 }).default('0.00').notNull(),
    salePrice: numeric('sale_price', { precision: 12, scale: 2 }).default('0.00').notNull(),
    ivaRate: numeric('iva_rate', { precision: 5, scale: 2 }).default('21.00').notNull(),
    ivaCode: integer('iva_code').default(5).notNull(), // AFIP 5 = 21%, 4 = 10.5%, 3 = 0%
    active: boolean('active').default(true).notNull(),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    uniqueIndex('products_tenant_internal_code_unique_idx').on(table.tenantId, table.internalCode)
  ]
);

export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;
