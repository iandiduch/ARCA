import { pgTable, uuid, text, boolean, timestamp } from 'drizzle-orm/pg-core';
import { fiscalIdentities } from './fiscal-identities.js';

export const fiscalCertificates = pgTable('fiscal_certificates', {
  id: uuid('id').primaryKey().defaultRandom(),
  fiscalIdentityId: uuid('fiscal_identity_id')
    .notNull()
    .references(() => fiscalIdentities.id, { onDelete: 'cascade' }),
  encryptedPrivateKey: text('encrypted_private_key').notNull(),
  privateKeyIv: text('private_key_iv').notNull(),
  privateKeyAuthTag: text('private_key_auth_tag').notNull(),
  csr: text('csr'),
  certificate: text('certificate'),
  certificateFingerprint: text('certificate_fingerprint'),
  validFrom: timestamp('valid_from', { withTimezone: true }),
  validTo: timestamp('valid_to', { withTimezone: true }),
  active: boolean('active').default(true).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
});

export type FiscalCertificate = typeof fiscalCertificates.$inferSelect;
export type NewFiscalCertificate = typeof fiscalCertificates.$inferInsert;
