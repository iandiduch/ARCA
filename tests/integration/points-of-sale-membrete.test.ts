import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { inArray, eq } from 'drizzle-orm';
import { createApp } from '../../src/app/server.js';
import { getDatabase, closeDatabaseConnection } from '../../src/infrastructure/database/connection.js';
import { tenants } from '../../src/infrastructure/database/schema/tenants.js';
import { apiKeys } from '../../src/infrastructure/database/schema/api-keys.js';
import { fiscalIdentities } from '../../src/infrastructure/database/schema/fiscal-identities.js';
import { pointsOfSale } from '../../src/infrastructure/database/schema/points-of-sale.js';
import { invoices } from '../../src/infrastructure/database/schema/invoices.js';
import { auditLogs } from '../../src/infrastructure/database/schema/audit-logs.js';
import { generateApiKey } from '../../src/core/security/api-key.js';
import { FiscalIdentityRepository } from '../../src/modules/fiscal-identities/infrastructure/fiscal-identity-repository.js';

describe('Membrete por punto de venta y datos fiscales obligatorios', () => {
  let app: FastifyInstance;
  let tenantAId: string;
  let tenantBId: string;
  let tenantAKey: string;
  let tenantBKey: string;
  let identityAId: string;
  let identityBId: string;
  let productionIdentityId: string;

  const repo = new FiscalIdentityRepository();

  async function createTenantWithKey(name: string, slugPrefix: string) {
    const db = getDatabase();
    const [tenant] = await db
      .insert(tenants)
      .values({ name, slug: `${slugPrefix}-${Date.now()}-${Math.floor(Math.random() * 100000)}` })
      .returning();
    const keyGen = generateApiKey();
    await db.insert(apiKeys).values({
      tenantId: tenant!.id,
      name: `Key ${name}`,
      keyHash: keyGen.keyHash,
      prefix: keyGen.prefix,
      role: 'admin'
    });
    return { tenantId: tenant!.id, rawKey: keyGen.rawKey };
  }

  beforeAll(async () => {
    app = await createApp({ enableLogging: false });
    await app.ready();

    const tenantA = await createTenantWithKey('Membrete Comercio A', 'membrete-a');
    tenantAId = tenantA.tenantId;
    tenantAKey = tenantA.rawKey;

    const tenantB = await createTenantWithKey('Membrete Comercio B', 'membrete-b');
    tenantBId = tenantB.tenantId;
    tenantBKey = tenantB.rawKey;

    // Identidad de Comercio A: se crea por API para ejercitar la normalización inicial
    const resA = await app.inject({
      method: 'POST',
      url: '/api/v1/fiscal-identities',
      headers: { 'x-api-key': tenantAKey },
      payload: {
        cuit: '30503612891',
        businessName: 'Ferretería Central S.A.',
        environment: 'homologation',
        taxCondition: 'responsable_inscripto',
        grossIncomeNumber: '901-234567-8',
        activityStartDate: '2020-01-01'
      }
    });
    expect(resA.statusCode).toBe(201);
    identityAId = resA.json().id;

    // Identidad de Comercio B: otro tenant para verificar aislamiento
    const resB = await app.inject({
      method: 'POST',
      url: '/api/v1/fiscal-identities',
      headers: { 'x-api-key': tenantBKey },
      payload: {
        cuit: '30712345671',
        businessName: 'Repuestos de Motos S.R.L.',
        environment: 'homologation'
      }
    });
    expect(resB.statusCode).toBe(201);
    identityBId = resB.json().id;

    // Puntos de venta cargados (en el flujo real los sincroniza la prueba de conexión con ARCA)
    const db = getDatabase();
    await db.insert(pointsOfSale).values([
      { fiscalIdentityId: identityAId, number: 1, type: 'ELECTRONICA', active: true },
      { fiscalIdentityId: identityAId, number: 2, type: 'ELECTRONICA', active: true },
      { fiscalIdentityId: identityAId, number: 6, type: 'ELECTRONICA', active: true },
      { fiscalIdentityId: identityAId, number: 7, type: 'ELECTRONICA', active: true },
      { fiscalIdentityId: identityBId, number: 1, type: 'ELECTRONICA', active: true }
    ]);

    // Identidad en producción sin datos fiscales obligatorios, insertada directo para no depender
    // de ALLOW_ARCA_PRODUCTION (la validación de emisión es independiente de la habilitación).
    const [productionIdentity] = await db
      .insert(fiscalIdentities)
      .values({
        tenantId: tenantAId,
        cuit: '30710955057',
        businessName: 'Producción sin datos S.A.',
        environment: 'production',
        status: 'CONNECTED'
      })
      .returning();
    productionIdentityId = productionIdentity!.id;

    await db.insert(pointsOfSale).values({
      fiscalIdentityId: productionIdentityId,
      number: 1,
      type: 'ELECTRONICA',
      active: true
    });
  });

  afterAll(async () => {
    const db = getDatabase();
    const tenantIds = [tenantAId, tenantBId];
    await db.delete(invoices).where(inArray(invoices.tenantId, tenantIds));
    await db.delete(auditLogs).where(inArray(auditLogs.tenantId, tenantIds));
    await db.delete(tenants).where(inArray(tenants.id, tenantIds));
    await app.close();
    await closeDatabaseConnection();
  });

  it('GET /status devuelve condición IVA canónica y datos fiscales de la identidad', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/fiscal-identities/${identityAId}/status`,
      headers: { 'x-api-key': tenantAKey }
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.taxCondition).toBe('IVA_RESPONSABLE_INSCRIPTO');
    expect(body.grossIncomeNumber).toBe('901-234567-8');
    expect(body.activityStartDate).toBe('2020-01-01');
    expect(body.puntosVenta.map((p: { number: number }) => p.number)).toEqual([1, 2, 6, 7]);
    expect(body.puntosVenta[0]).toMatchObject({ fantasyName: null, commercialAddress: null });
  });

  it("PATCH /fiscal-identities/:id con taxCondition 'monotributo' guarda RESPONSABLE_MONOTRIBUTO", async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/fiscal-identities/${identityAId}`,
      headers: { 'x-api-key': tenantAKey },
      payload: { taxCondition: 'monotributo', fantasyName: 'Ferretería Central' }
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().taxCondition).toBe('RESPONSABLE_MONOTRIBUTO');
    expect(res.json().fantasyName).toBe('Ferretería Central');

    const statusRes = await app.inject({
      method: 'GET',
      url: `/api/v1/fiscal-identities/${identityAId}/status`,
      headers: { 'x-api-key': tenantAKey }
    });
    expect(statusRes.json().taxCondition).toBe('RESPONSABLE_MONOTRIBUTO');
  });

  it('PATCH /fiscal-identities/:id rechaza una condición IVA desconocida', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/fiscal-identities/${identityAId}`,
      headers: { 'x-api-key': tenantAKey },
      payload: { taxCondition: 'cualquiera' }
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('Condición frente al IVA');
  });

  it('PATCH /fiscal-identities/:id rechaza una fecha de inicio futura y un IIBB inválido', async () => {
    const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const resFuture = await app.inject({
      method: 'PATCH',
      url: `/api/v1/fiscal-identities/${identityAId}`,
      headers: { 'x-api-key': tenantAKey },
      payload: { activityStartDate: futureDate }
    });
    expect(resFuture.statusCode).toBe(400);

    const resIibb = await app.inject({
      method: 'PATCH',
      url: `/api/v1/fiscal-identities/${identityAId}`,
      headers: { 'x-api-key': tenantAKey },
      payload: { grossIncomeNumber: 'no-es-un-numero' }
    });
    expect(resIibb.statusCode).toBe(400);
  });

  it('PATCH /fiscal-identities/:id/points-of-sale/:number guarda el membrete y aparece en /status', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/fiscal-identities/${identityAId}/points-of-sale/6`,
      headers: { 'x-api-key': tenantAKey },
      payload: {
        fantasyName: 'Ferretería',
        commercialAddress: 'Av. San Martín 1234, Taco Pozo'
      }
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      number: 6,
      fantasyName: 'Ferretería',
      commercialAddress: 'Av. San Martín 1234, Taco Pozo'
    });

    const statusRes = await app.inject({
      method: 'GET',
      url: `/api/v1/fiscal-identities/${identityAId}/status`,
      headers: { 'x-api-key': tenantAKey }
    });
    const pv6 = statusRes
      .json()
      .puntosVenta.find((p: { number: number }) => p.number === 6);
    expect(pv6).toMatchObject({
      fantasyName: 'Ferretería',
      commercialAddress: 'Av. San Martín 1234, Taco Pozo'
    });
    // Los demás PV siguen sin membrete propio
    const pv1 = statusRes
      .json()
      .puntosVenta.find((p: { number: number }) => p.number === 1);
    expect(pv1).toMatchObject({ fantasyName: null, commercialAddress: null });
  });

  it('string vacío en el PATCH de un PV se guarda como null', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/fiscal-identities/${identityAId}/points-of-sale/7`,
      headers: { 'x-api-key': tenantAKey },
      payload: { fantasyName: 'Repuestos de Motos', commercialAddress: 'Ruta 16 Km 3' }
    });
    expect(res.statusCode).toBe(200);

    const resClear = await app.inject({
      method: 'PATCH',
      url: `/api/v1/fiscal-identities/${identityAId}/points-of-sale/7`,
      headers: { 'x-api-key': tenantAKey },
      payload: { fantasyName: '', commercialAddress: '   ' }
    });
    expect(resClear.statusCode).toBe(200);
    expect(resClear.json()).toEqual({ number: 7, fantasyName: null, commercialAddress: null });
  });

  it('PATCH de un PV inexistente devuelve 404', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/fiscal-identities/${identityAId}/points-of-sale/99`,
      headers: { 'x-api-key': tenantAKey },
      payload: { fantasyName: 'Sucursal inexistente' }
    });

    expect(res.statusCode).toBe(404);
  });

  it('PATCH del PV de una identidad de otro tenant devuelve 404', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/fiscal-identities/${identityAId}/points-of-sale/6`,
      headers: { 'x-api-key': tenantBKey },
      payload: { fantasyName: 'Intento ajeno' }
    });

    expect(res.statusCode).toBe(404);

    // El membrete de Comercio A no cambió
    const pv = await repo.findPointOfSaleByNumber(identityAId, 6);
    expect(pv?.fantasyName).toBe('Ferretería');
  });

  it('re-sincronizar los PV con ARCA conserva el membrete por número', async () => {
    // Autocontenido: no depende del membrete que hayan dejado los tests anteriores
    await repo.updatePointOfSaleMembrete(identityAId, 6, {
      fantasyName: 'Ferretería',
      commercialAddress: 'Av. San Martín 1234, Taco Pozo'
    });
    await repo.updatePointOfSaleMembrete(identityAId, 7, {
      fantasyName: null,
      commercialAddress: null
    });

    const synced = await repo.syncPointsOfSale(identityAId, [
      { fiscalIdentityId: identityAId, number: 6, type: 'ELECTRONICA', active: true },
      { fiscalIdentityId: identityAId, number: 7, type: 'ELECTRONICA', active: true },
      { fiscalIdentityId: identityAId, number: 8, type: 'ELECTRONICA', active: true }
    ]);

    const byNumber = new Map(synced.map((p) => [p.number, p]));
    expect(byNumber.get(6)).toMatchObject({
      fantasyName: 'Ferretería',
      commercialAddress: 'Av. San Martín 1234, Taco Pozo'
    });
    expect(byNumber.get(7)).toMatchObject({ fantasyName: null, commercialAddress: null });
    expect(byNumber.get(8)).toMatchObject({ fantasyName: null, commercialAddress: null });
  });

  it('en producción no se emite (ni se crea borrador) sin IIBB e inicio de actividades', async () => {
    const draftPayload = {
      fiscalIdentityId: productionIdentityId,
      pointOfSaleNumber: 1,
      voucherType: 6,
      items: [{ description: 'Taladro Percutor 750W', quantity: 1, unitPrice: 45000, vatRate: 21.0 }]
    };

    const resMissing = await app.inject({
      method: 'POST',
      url: '/api/v1/invoices/drafts',
      headers: { 'x-api-key': tenantAKey },
      payload: draftPayload
    });
    expect(resMissing.statusCode).toBe(400);
    expect(resMissing.json().message).toContain('Ingresos Brutos');
    expect(resMissing.json().message).toContain('inicio de actividades');

    // Completados los datos, el borrador ya se puede crear (homologación no los exige)
    await getDatabase()
      .update(fiscalIdentities)
      .set({ grossIncomeNumber: '901-234567-8', activityStartDate: '2020-01-01' })
      .where(eq(fiscalIdentities.id, productionIdentityId));

    const resOk = await app.inject({
      method: 'POST',
      url: '/api/v1/invoices/drafts',
      headers: { 'x-api-key': tenantAKey },
      payload: draftPayload
    });
    expect(resOk.statusCode).toBe(201);
    expect(resOk.json().status).toBe('DRAFT');
  });
});
