import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../../src/app/server.js';
import { getDatabase, closeDatabaseConnection } from '../../src/infrastructure/database/connection.js';
import { tenants } from '../../src/infrastructure/database/schema/tenants.js';
import { apiKeys } from '../../src/infrastructure/database/schema/api-keys.js';
import { fiscalIdentities } from '../../src/infrastructure/database/schema/fiscal-identities.js';
import { pointsOfSale } from '../../src/infrastructure/database/schema/points-of-sale.js';
import { invoices } from '../../src/infrastructure/database/schema/invoices.js';
import { invoiceVatSubtotals } from '../../src/infrastructure/database/schema/invoice-vat-subtotals.js';
import { generateApiKey } from '../../src/core/security/api-key.js';

describe('Reportes Fiscales y Libro IVA Ventas (Fase 7)', () => {
  let app: FastifyInstance;
  let tenantAId: string;
  let tenantBId: string;
  let tenantAKey: string;
  let tenantBKey: string;
  let fiscalIdentityAId: string;

  beforeAll(async () => {
    app = await createApp({ enableLogging: false });
    const db = getDatabase();

    await db.delete(invoiceVatSubtotals);
    await db.delete(invoices);
    await db.delete(pointsOfSale);
    await db.delete(fiscalIdentities);
    await db.delete(apiKeys);
    await db.delete(tenants);

    const [tA] = await db.insert(tenants).values({ name: 'Comercio A', slug: `comercio-a-rep-${Date.now()}` }).returning();
    const [tB] = await db.insert(tenants).values({ name: 'Comercio B', slug: `comercio-b-rep-${Date.now()}` }).returning();
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
        businessName: 'Distribuidora Mayorista S.A.',
        environment: 'homologation',
        status: 'CONNECTED'
      })
      .returning();
    fiscalIdentityAId = identA!.id;

    // Factura 1: Factura B autorizada
    const [inv1] = await db
      .insert(invoices)
      .values({
        tenantId: tenantAId,
        fiscalIdentityId: fiscalIdentityAId,
        pointOfSaleNumber: 1,
        voucherType: 6,
        voucherLetter: 'B',
        voucherNumber: 101,
        status: 'AUTHORIZED',
        cae: '74111111111111',
        totalAmount: '2315.00',
        netTaxedAmount: '2000.00',
        vatAmount: '315.00',
        customerName: 'Consumidor Final',
        customerDocType: 99,
        customerDocNumber: '0'
      })
      .returning();

    await db.insert(invoiceVatSubtotals).values([
      {
        invoiceId: inv1!.id,
        vatAfipCode: 5,
        vatRate: '21.00',
        baseAmount: '1000.00',
        vatAmount: '210.00'
      },
      {
        invoiceId: inv1!.id,
        vatAfipCode: 4,
        vatRate: '10.50',
        baseAmount: '1000.00',
        vatAmount: '105.00'
      }
    ]);

    // Factura 2: Factura A autorizada
    const [inv2] = await db
      .insert(invoices)
      .values({
        tenantId: tenantAId,
        fiscalIdentityId: fiscalIdentityAId,
        pointOfSaleNumber: 1,
        voucherType: 1,
        voucherLetter: 'A',
        voucherNumber: 45,
        status: 'AUTHORIZED',
        cae: '74222222222222',
        totalAmount: '12100.00',
        netTaxedAmount: '10000.00',
        vatAmount: '2100.00',
        customerName: 'Cliente Mayorista S.R.L.',
        customerDocType: 80,
        customerDocNumber: '30712345678',
        customerTaxCondition: 1
      })
      .returning();

    await db.insert(invoiceVatSubtotals).values([
      {
        invoiceId: inv2!.id,
        vatAfipCode: 5,
        vatRate: '21.00',
        baseAmount: '10000.00',
        vatAmount: '2100.00'
      }
    ]);

    // Factura 3: Borrador local (no debe sumar en total facturado)
    await db.insert(invoices).values({
      tenantId: tenantAId,
      fiscalIdentityId: fiscalIdentityAId,
      pointOfSaleNumber: 1,
      voucherType: 6,
      voucherLetter: 'B',
      voucherNumber: null,
      status: 'DRAFT',
      totalAmount: '5000.00',
      netTaxedAmount: '4132.23',
      vatAmount: '867.77',
      customerName: 'Borrador'
    });
  });

  afterAll(async () => {
    await app.close();
    await closeDatabaseConnection();
  });

  it('1. GET /api/v1/reports/sales - Reporte consolidado de ventas y totales fiscales', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/reports/sales',
      headers: { 'x-api-key': tenantAKey }
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();

    // Solo facturas autorizadas suman (2315 + 12100 = 14415)
    expect(body.summary.totalInvoiced).toBe(14415);
    expect(body.summary.totalNet).toBe(12000);
    expect(body.summary.totalVat).toBe(2415);
    expect(body.summary.counts.authorized).toBe(2);
    expect(body.summary.counts.draft).toBe(1);

    // Desglose por tipo de comprobante
    expect(body.byVoucherType).toHaveLength(2);
    const facturaA = body.byVoucherType.find((v: { voucherType: number }) => v.voucherType === 1);
    expect(facturaA).toBeDefined();
    expect(facturaA.total).toBe(12100);

    // Desglose de IVA por tasa oficial
    expect(body.byVatRate).toHaveLength(2);
    const iva21 = body.byVatRate.find((v: { vatAfipCode: number }) => v.vatAfipCode === 5);
    expect(iva21).toBeDefined();
    expect(iva21.baseAmount).toBe(11000);
    expect(iva21.vatAmount).toBe(2310);
  });

  it('2. GET /api/v1/reports/vat-sales-ledger?format=csv - Exportación de Libro IVA Ventas en CSV', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/reports/vat-sales-ledger?format=csv',
      headers: { 'x-api-key': tenantAKey }
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment; filename=');

    const csvLines = res.body.split('\r\n');
    expect(csvLines.length).toBeGreaterThanOrEqual(3);

    // Verificar cabecera
    expect(csvLines[0]).toContain('Fecha;Tipo Comprobante;Pto. Venta;Nro. Comprobante;');

    // Verificar datos de comprobantes
    expect(res.body).toContain('Factura A');
    expect(res.body).toContain('Factura B');
    expect(res.body).toContain('74111111111111');
    expect(res.body).toContain('74222222222222');
    expect(res.body).not.toContain('Borrador'); // Los borradores no van al libro IVA oficial
  });

  it('3. AISLAMIENTO MULTI-TENANT: Comercio B tiene reportes en cero', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/reports/sales',
      headers: { 'x-api-key': tenantBKey }
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.summary.totalInvoiced).toBe(0);
    expect(body.summary.counts.authorized).toBe(0);
    expect(body.byVoucherType).toHaveLength(0);
  });
});
