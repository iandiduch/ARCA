import { pgTable, uuid, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { fiscalIdentities } from './fiscal-identities.js';

export const wsaaAccessTickets = pgTable(
  'wsaa_access_tickets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fiscalIdentityId: uuid('fiscal_identity_id')
      .notNull()
      .references(() => fiscalIdentities.id, { onDelete: 'cascade' }),
    service: text('service').default('wsfe').notNull(),
    environment: text('environment').default('homologation').notNull(),
    token: text('token').notNull(),
    sign: text('sign').notNull(),
    generationTime: timestamp('generation_time', { withTimezone: true }).notNull(),
    expirationTime: timestamp('expiration_time', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    uniqueIndex('wsaa_tickets_identity_service_env_idx').on(
      table.fiscalIdentityId,
      table.service,
      table.environment
    )
  ]
);

export type WsaaAccessTicket = typeof wsaaAccessTickets.$inferSelect;
export type NewWsaaAccessTicket = typeof wsaaAccessTickets.$inferInsert;
