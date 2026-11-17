import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import { createApp } from '../../src/app/server.js';
import { getDatabase, closeDatabaseConnection } from '../../src/infrastructure/database/connection.js';
import { tenants } from '../../src/infrastructure/database/schema/tenants.js';
import { apiKeys } from '../../src/infrastructure/database/schema/api-keys.js';
import { fiscalIdentities } from '../../src/infrastructure/database/schema/fiscal-identities.js';
import { pointsOfSale } from '../../src/infrastructure/database/schema/points-of-sale.js';
import { auditLogs } from '../../src/infrastructure/database/schema/audit-logs.js';
import { generateApiKey } from '../../src/core/security/api-key.js';
import { AuditService } from '../../src/modules/audit/application/audit-service.js';

describe('Contexto de auditoría: IP y API Key del pedido HTTP', () => {
  let app: FastifyInstance;
  let tenantId: string;
  let apiKeyId: string;
  let apiKey: string;
  let identityId: string;
  let pointOfSale2Id: string;
  let tenantBId: string;
  let apiKeyBId: string;
  let apiKeyB: string;
  let identityBId: string;
  let pointOfSaleBId: string;

  beforeAll(async () => {
    app = await createApp({ enableLogging: false });
    await app.ready();

    const db = getDatabase();
    const [tenant] = await db
      .insert(tenants)
      .values({ name: 'Auditoría Contexto', slug: `audit-context-${Date.now()}-${Math.floor(Math.random() * 100000)}` })
      .returning();
    tenantId = tenant!.id;

    const keyGen = generateApiKey();
    const [key] = await db
      .insert(apiKeys)
      .values({
        tenantId,
        name: 'Key Auditoría',
        keyHash: keyGen.keyHash,
        prefix: keyGen.prefix,
        role: 'admin'
      })
      .returning();
    apiKeyId = key!.id;
    apiKey = keyGen.rawKey;

    const [identity] = await db
      .insert(fiscalIdentities)
      .values({
        tenantId,
        cuit: '30503612891',
        businessName: 'Auditoría Contexto S.A.',
        environment: 'homologation',
        status: 'CONNECTED'
      })
      .returning();
    identityId = identity!.id;

    await db.insert(pointsOfSale).values({
      fiscalIdentityId: identityId,
      number: 1,
      type: 'ELECTRONICA',
      active: true
    });

    const [pointOfSale2] = await db
      .insert(pointsOfSale)
      .values({
        fiscalIdentityId: identityId,
        number: 2,
        type: 'ELECTRONICA',
        active: true
      })
      .returning();
    pointOfSale2Id = pointOfSale2!.id;

    // Segundo tenant con su propia API key, para verificar el aislamiento de la auditoría
    const [tenantB] = await db
      .insert(tenants)
      .values({ name: 'Auditoría Contexto B', slug: `audit-context-b-${Date.now()}-${Math.floor(Math.random() * 100000)}` })
      .returning();
    tenantBId = tenantB!.id;

    const keyGenB = generateApiKey();
    const [keyB] = await db
      .insert(apiKeys)
      .values({
        tenantId: tenantBId,
        name: 'Key Auditoría B',
        keyHash: keyGenB.keyHash,
        prefix: keyGenB.prefix,
        role: 'admin'
      })
      .returning();
    apiKeyBId = keyB!.id;
    apiKeyB = keyGenB.rawKey;

    const [identityB] = await db
      .insert(fiscalIdentities)
      .values({
        tenantId: tenantBId,
        cuit: '30712345671',
        businessName: 'Auditoría Contexto B S.R.L.',
        environment: 'homologation',
        status: 'CONNECTED'
      })
      .returning();
    identityBId = identityB!.id;

    const [pointOfSaleB] = await db
      .insert(pointsOfSale)
      .values({
        fiscalIdentityId: identityBId,
        number: 1,
        type: 'ELECTRONICA',
        active: true
      })
      .returning();
    pointOfSaleBId = pointOfSaleB!.id;
  });

  afterAll(async () => {
    const db = getDatabase();
    await db.delete(auditLogs).where(inArray(auditLogs.tenantId, [tenantId, tenantBId]));
    await db.delete(tenants).where(inArray(tenants.id, [tenantId, tenantBId]));
    await app.close();
    await closeDatabaseConnection();
  });

  it('el PATCH de un punto de venta audita api_key_id e ip_address aunque el service no los pase', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/fiscal-identities/${identityId}/points-of-sale/1`,
      headers: { 'x-api-key': apiKey },
      payload: { fantasyName: 'Sucursal Auditada', commercialAddress: 'Calle Falsa 123' }
    });
    expect(res.statusCode).toBe(200);

    const rows = await getDatabase()
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.tenantId, tenantId), eq(auditLogs.action, 'POINT_OF_SALE_UPDATED')));

    expect(rows).toHaveLength(1);
    const log = rows[0]!;
    expect(log.entityType).toBe('point_of_sale');
    expect(log.apiKeyId).toBe(apiKeyId);
    expect(log.ipAddress).toBe('127.0.0.1');
  });

  it('dos PATCH concurrentes de PV de tenants distintos auditan cada uno su API key', async () => {
    const [resA, resB] = await Promise.all([
      app.inject({
        method: 'PATCH',
        url: `/api/v1/fiscal-identities/${identityId}/points-of-sale/2`,
        headers: { 'x-api-key': apiKey },
        payload: { fantasyName: 'Sucursal Concurrente A' }
      }),
      app.inject({
        method: 'PATCH',
        url: `/api/v1/fiscal-identities/${identityBId}/points-of-sale/1`,
        headers: { 'x-api-key': apiKeyB },
        payload: { fantasyName: 'Sucursal Concurrente B' }
      })
    ]);
    expect(resA.statusCode).toBe(200);
    expect(resB.statusCode).toBe(200);

    const rows = await getDatabase()
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, 'POINT_OF_SALE_UPDATED'),
          inArray(auditLogs.entityId, [pointOfSale2Id, pointOfSaleBId])
        )
      );

    expect(rows).toHaveLength(2);
    const byEntity = new Map(rows.map((row) => [row.entityId, row]));
    expect(byEntity.get(pointOfSale2Id)).toMatchObject({
      tenantId,
      apiKeyId,
      entityType: 'point_of_sale'
    });
    expect(byEntity.get(pointOfSaleBId)).toMatchObject({
      tenantId: tenantBId,
      apiKeyId: apiKeyBId,
      entityType: 'point_of_sale'
    });
  });

  it('fuera de un pedido HTTP no se inventan IP ni API Key', async () => {
    await AuditService.record({
      tenantId,
      action: 'AUDIT_WITHOUT_REQUEST',
      entityType: 'test'
    });

    const [log] = await getDatabase()
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.tenantId, tenantId), eq(auditLogs.action, 'AUDIT_WITHOUT_REQUEST')));

    expect(log).toBeDefined();
    expect(log!.apiKeyId).toBeNull();
    expect(log!.ipAddress).toBeNull();
  });
});
