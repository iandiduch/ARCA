import { pgTable, uuid, text, integer, boolean, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { fiscalIdentities } from './fiscal-identities.js';

export const pointsOfSale = pgTable(
  'points_of_sale',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fiscalIdentityId: uuid('fiscal_identity_id')
      .notNull()
      .references(() => fiscalIdentities.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(), // ej: 1, 2, ... 99999
    type: text('type').default('ELECTRONIC').notNull(), // 'ELECTRONIC', 'MANUAL', 'FISCAL_CONTROLLER'
    description: text('description'),
    active: boolean('active').default(true).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    uniqueIndex('points_of_sale_identity_number_idx').on(table.fiscalIdentityId, table.number)
  ]
);

export type PointOfSale = typeof pointsOfSale.$inferSelect;
export type NewPointOfSale = typeof pointsOfSale.$inferInsert;
