import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../../src/app/server.js';
import { getDatabase, closeDatabaseConnection } from '../../src/infrastructure/database/connection.js';
import { tenants } from '../../src/infrastructure/database/schema/tenants.js';
import { apiKeys } from '../../src/infrastructure/database/schema/api-keys.js';
import { fiscalIdentities } from '../../src/infrastructure/database/schema/fiscal-identities.js';
import { pointsOfSale } from '../../src/infrastructure/database/schema/points-of-sale.js';
import { invoices } from '../../src/infrastructure/database/schema/invoices.js';
import { generateApiKey } from '../../src/core/security/api-key.js';

describe('Documentos Fiscales: PDF, Ticket Térmico, QR y Email (Fase 6)', () => {
  let app: FastifyInstance;
  let tenantAId: string;
  let tenantBId: string;
  let tenantAKey: string;
  let tenantBKey: string;
  let fiscalIdentityAId: string;
  let invoiceAId: string;

  beforeAll(async () => {
    app = await createApp({ enableLogging: false });
    const db = getDatabase();

    await db.delete(invoices);
    await db.delete(pointsOfSale);
    await db.delete(fiscalIdentities);
    await db.delete(apiKeys);
    await db.delete(tenants);

    const [tA] = await db.insert(tenants).values({ name: 'Ferretería A', slug: 'ferreteria-a' }).returning();
    const [tB] = await db.insert(tenants).values({ name: 'Ferretería B', slug: 'ferreteria-b' }).returning();
    tenantAId = tA!.id;
    tenantBId = tB!.id;

    const keyGenA = generateApiKey();
    await db.insert(apiKeys).values({
      tenantId: tenantAId,
      name: 'Key A',
      keyHash: keyGenA.keyHash,
      prefix: keyGenA.prefix,
      role: 'ADMIN'
    });
    tenantAKey = keyGenA.rawKey;

    const keyGenB = generateApiKey();
    await db.insert(apiKeys).values({
      tenantId: tenantBId,
      name: 'Key B',
      keyHash: keyGenB.keyHash,
      prefix: keyGenB.prefix,
      role: 'ADMIN'
    });
    tenantBKey = keyGenB.rawKey;

    const [identA] = await db
      .insert(fiscalIdentities)
      .values({
        tenantId: tenantAId,
        cuit: '20301234567',
        businessName: 'Ferretería Central S.A.',
        environment: 'homologation',
        status: 'CONNECTED'
      })
      .returning();
    fiscalIdentityAId = identA!.id;

    await db.insert(pointsOfSale).values({
      fiscalIdentityId: fiscalIdentityAId,
      number: 1,
      type: 'ELECTRONICA',
      active: true
    });

    // Crear un comprobante borrador para pruebas
    const draftRes = await app.inject({
      method: 'POST',
      url: '/api/v1/invoices/drafts',
      headers: { 'x-api-key': tenantAKey },
      payload: {
        fiscalIdentityId: fiscalIdentityAId,
        pointOfSaleNumber: 1,
        voucherType: 6,
        items: [
          {
            description: 'Taladro Percutor 750W',
            quantity: 1,
            unitPrice: 45000,
            vatRate: 21.0
          }
        ]
      }
    });

    invoiceAId = draftRes.json().id;
  });

  afterAll(async () => {
    await app.close();
    await closeDatabaseConnection();
  });

  it('1. GET /api/v1/invoices/:id/pdf - Generación y descarga de archivo PDF', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/invoices/${invoiceAId}/pdf`,
      headers: { 'x-api-key': tenantAKey }
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toContain('inline; filename=');

    const pdfBuffer = res.rawPayload;
    expect(pdfBuffer.length).toBeGreaterThan(1000);
    expect(pdfBuffer.slice(0, 5).toString('ascii')).toBe('%PDF-');
  });

  it('2. GET /api/v1/invoices/:id/thermal - Formato ticket térmico (texto y HTML)', async () => {
    // Modo texto plano
    const resText = await app.inject({
      method: 'GET',
      url: `/api/v1/invoices/${invoiceAId}/thermal?format=text&widthMm=80`,
      headers: { 'x-api-key': tenantAKey }
    });

    expect(resText.statusCode).toBe(200);
    expect(resText.headers['content-type']).toContain('text/plain');
    expect(resText.body).toContain('FERRETERÍA CENTRAL S.A.');
    expect(resText.body).toContain('Taladro Percutor 750W');
    expect(resText.body).toContain('$45000.00');

    // Modo HTML
    const resHtml = await app.inject({
      method: 'GET',
      url: `/api/v1/invoices/${invoiceAId}/thermal?format=html&widthMm=80`,
      headers: { 'x-api-key': tenantAKey }
    });

    expect(resHtml.statusCode).toBe(200);
    expect(resHtml.headers['content-type']).toContain('text/html');
    expect(resHtml.body).toContain('<html');
  });

  it('3. GET /api/v1/invoices/:id/qr - Imagen PNG y SVG del QR fiscal', async () => {
    // Formato PNG
    const resPng = await app.inject({
      method: 'GET',
      url: `/api/v1/invoices/${invoiceAId}/qr?format=png&width=200`,
      headers: { 'x-api-key': tenantAKey }
    });

    expect(resPng.statusCode).toBe(200);
    expect(resPng.headers['content-type']).toBe('image/png');
    expect(resPng.rawPayload[0]).toBe(0x89);
    expect(resPng.rawPayload[1]).toBe(0x50);

    // Formato SVG
    const resSvg = await app.inject({
      method: 'GET',
      url: `/api/v1/invoices/${invoiceAId}/qr?format=svg&width=200`,
      headers: { 'x-api-key': tenantAKey }
    });

    expect(resSvg.statusCode).toBe(200);
    expect(resSvg.headers['content-type']).toContain('image/svg+xml');
    expect(resSvg.body).toContain('<svg');
  });

  it('4. POST /api/v1/invoices/:id/email - Envío de comprobante por correo con PDF adjunto', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${invoiceAId}/email`,
      headers: { 'x-api-key': tenantAKey },
      payload: {
        to: 'comprador@cliente.com',
        subject: 'Su comprobante de compra en Ferretería Central',
        customMessage: 'Adjuntamos su factura electrónica oficial.'
      }
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.sentTo).toBe('comprador@cliente.com');
    expect(body.messageId).toBeDefined();
  });

  it('5. AISLAMIENTO MULTI-TENANT: Comercio B NO puede acceder al PDF de Comercio A', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/invoices/${invoiceAId}/pdf`,
      headers: { 'x-api-key': tenantBKey }
    });

    expect(res.statusCode).toBe(404);
  });
});
