import { pgTable, uuid, text, integer, timestamp, jsonb, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    resource: text('resource').default('invoices').notNull(),
    status: text('status').notNull(), // 'PROCESSING', 'COMPLETED', 'FAILED'
    statusCode: integer('status_code'),
    responseBody: jsonb('response_body'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    uniqueIndex('idempotency_keys_tenant_key_unique_idx').on(table.tenantId, table.key)
  ]
);

export type IdempotencyKey = typeof idempotencyKeys.$inferSelect;
export type NewIdempotencyKey = typeof idempotencyKeys.$inferInsert;
