import { eq, and, desc, sql } from 'drizzle-orm';
import { getDatabase } from '../../../infrastructure/database/connection.js';
import {
  fiscalIdentities,
  type FiscalIdentity,
  type NewFiscalIdentity
} from '../../../infrastructure/database/schema/fiscal-identities.js';
import {
  fiscalCertificates,
  type FiscalCertificate,
  type NewFiscalCertificate
} from '../../../infrastructure/database/schema/fiscal-certificates.js';
import {
  pointsOfSale,
  type PointOfSale,
  type NewPointOfSale
} from '../../../infrastructure/database/schema/points-of-sale.js';
import { invoices } from '../../../infrastructure/database/schema/invoices.js';

export class FiscalIdentityRepository {
  public async create(data: NewFiscalIdentity): Promise<FiscalIdentity> {
    const db = getDatabase();
    const [created] = await db.insert(fiscalIdentities).values(data).returning();
    if (!created) throw new Error('Fallo al crear identidad fiscal');
    return created;
  }

  public async findById(tenantId: string, id: string): Promise<FiscalIdentity | null> {
    const db = getDatabase();
    const [found] = await db
      .select()
      .from(fiscalIdentities)
      .where(and(eq(fiscalIdentities.tenantId, tenantId), eq(fiscalIdentities.id, id)))
      .limit(1);

    return found ?? null;
  }

  public async findByCuit(
    tenantId: string,
    cuit: string,
    environment: string
  ): Promise<FiscalIdentity | null> {
    const db = getDatabase();
    const [found] = await db
      .select()
      .from(fiscalIdentities)
      .where(
        and(
          eq(fiscalIdentities.tenantId, tenantId),
          eq(fiscalIdentities.cuit, cuit),
          eq(fiscalIdentities.environment, environment)
        )
      )
      .limit(1);

    return found ?? null;
  }

  public async listByTenant(tenantId: string): Promise<FiscalIdentity[]> {
    const db = getDatabase();
    return db.select().from(fiscalIdentities).where(eq(fiscalIdentities.tenantId, tenantId));
  }

  public async countInvoices(fiscalIdentityId: string): Promise<number> {
    const db = getDatabase();
    const [row] = await db
      .select({ count: sql<number>`cast(count(*) as integer)` })
      .from(invoices)
      .where(eq(invoices.fiscalIdentityId, fiscalIdentityId));

    return row?.count ?? 0;
  }

  public async delete(tenantId: string, id: string): Promise<boolean> {
    const db = getDatabase();
    const [deleted] = await db
      .delete(fiscalIdentities)
      .where(and(eq(fiscalIdentities.tenantId, tenantId), eq(fiscalIdentities.id, id)))
      .returning();

    return Boolean(deleted);
  }

  public async update(
    tenantId: string,
    id: string,
    data: Partial<Omit<NewFiscalIdentity, 'id' | 'tenantId' | 'createdAt'>>
  ): Promise<FiscalIdentity | null> {
    const db = getDatabase();
    const [updated] = await db
      .update(fiscalIdentities)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(fiscalIdentities.tenantId, tenantId), eq(fiscalIdentities.id, id)))
      .returning();

    return updated ?? null;
  }

  // Certificados
  public async saveCertificate(data: NewFiscalCertificate): Promise<FiscalCertificate> {
    const db = getDatabase();
    if (data.active !== false) {
      await db
        .update(fiscalCertificates)
        .set({ active: false })
        .where(eq(fiscalCertificates.fiscalIdentityId, data.fiscalIdentityId));
    }
    const [created] = await db.insert(fiscalCertificates).values(data).returning();
    if (!created) throw new Error('Fallo al guardar certificado fiscal');
    return created;
  }

  public async getActiveCertificate(fiscalIdentityId: string): Promise<FiscalCertificate | null> {
    const db = getDatabase();
    const [found] = await db
      .select()
      .from(fiscalCertificates)
      .where(
        and(
          eq(fiscalCertificates.fiscalIdentityId, fiscalIdentityId),
          eq(fiscalCertificates.active, true)
        )
      )
      .orderBy(desc(fiscalCertificates.createdAt))
      .limit(1);

    return found ?? null;
  }

  // Puntos de venta
  public async syncPointsOfSale(fiscalIdentityId: string, ptos: NewPointOfSale[]): Promise<PointOfSale[]> {
    const db = getDatabase();
    if (ptos.length === 0) return [];

    // Desactivar previos o insertar
    await db
      .delete(pointsOfSale)
      .where(eq(pointsOfSale.fiscalIdentityId, fiscalIdentityId));

    return db.insert(pointsOfSale).values(ptos).returning();
  }

  public async getPointsOfSale(fiscalIdentityId: string): Promise<PointOfSale[]> {
    const db = getDatabase();
    return db
      .select()
      .from(pointsOfSale)
      .where(and(eq(pointsOfSale.fiscalIdentityId, fiscalIdentityId), eq(pointsOfSale.active, true)));
  }
}
