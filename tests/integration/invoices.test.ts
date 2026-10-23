import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import forge from 'node-forge';
import { createApp } from '../../src/app/server.js';
import { getDatabase, closeDatabaseConnection } from '../../src/infrastructure/database/connection.js';
import { tenants } from '../../src/infrastructure/database/schema/tenants.js';
import { apiKeys } from '../../src/infrastructure/database/schema/api-keys.js';
import { fiscalIdentities } from '../../src/infrastructure/database/schema/fiscal-identities.js';
import { fiscalCertificates } from '../../src/infrastructure/database/schema/fiscal-certificates.js';
import { pointsOfSale } from '../../src/infrastructure/database/schema/points-of-sale.js';
import { invoices } from '../../src/infrastructure/database/schema/invoices.js';
import { idempotencyKeys } from '../../src/infrastructure/database/schema/idempotency-keys.js';
import { generateApiKey } from '../../src/core/security/api-key.js';
import { EncryptionService } from '../../src/core/security/encryption.js';
import { WsaaClient } from '../../src/modules/arca/infrastructure/wsaa/wsaa-client.js';
import { Wsfev1Client } from '../../src/modules/arca/infrastructure/wsfev1/wsfev1-client.js';
import { InfrastructureError } from '../../src/core/errors/app-error.js';

describe('Facturación Electrónica y Comprobantes ARCA (Fase 5)', () => {
  let app: FastifyInstance;
  let tenantAId: string;
  let tenantBId: string;
  let tenantAKey: string;
  let tenantBKey: string;
  let fiscalIdentityAId: string;

  beforeAll(async () => {
    app = await createApp({ enableLogging: false });
    const db = getDatabase();

    // Limpieza
    await db.delete(invoices);
    await db.delete(idempotencyKeys);
    await db.delete(pointsOfSale);
    await db.delete(fiscalCertificates);
    await db.delete(fiscalIdentities);
    await db.delete(apiKeys);
    await db.delete(tenants);

    // Crear Tenant A y B
    const [tA] = await db.insert(tenants).values({ name: 'Comercio A', slug: 'comercio-a' }).returning();
    const [tB] = await db.insert(tenants).values({ name: 'Comercio B', slug: 'comercio-b' }).returning();
    tenantAId = tA!.id;
    tenantBId = tB!.id;

    const keyGenA = generateApiKey();
    await db.insert(apiKeys).values({
      tenantId: tenantAId,
      name: 'POS Terminal 1',
      keyHash: keyGenA.keyHash,
      prefix: keyGenA.prefix,
      role: 'ADMIN'
    });
    tenantAKey = keyGenA.rawKey;

    const keyGenB = generateApiKey();
    await db.insert(apiKeys).values({
      tenantId: tenantBId,
      name: 'POS Terminal 2',
      keyHash: keyGenB.keyHash,
      prefix: keyGenB.prefix,
      role: 'ADMIN'
    });
    tenantBKey = keyGenB.rawKey;

    // Crear Identidad Fiscal para Comercio A
    const [identA] = await db
      .insert(fiscalIdentities)
      .values({
        tenantId: tenantAId,
        cuit: '20301234567',
        businessName: 'Comercio A S.R.L.',
        environment: 'homologation',
        status: 'CONNECTED'
      })
      .returning();
    fiscalIdentityAId = identA!.id;

    // Crear Clave y Certificado X.509 de prueba para Comercio A
    const keys = forge.pki.rsa.generateKeyPair({ bits: 1024 });
    const privateKeyPem = forge.pki.privateKeyToPem(keys.privateKey);

    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01';
    cert.validity.notBefore = new Date(Date.now() - 3600000);
    cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 3600000);
    cert.setSubject([{ name: 'commonName', value: 'computador1' }]);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    const certPem = forge.pki.certificateToPem(cert);

    const enc = EncryptionService.encrypt(privateKeyPem);
    await db.insert(fiscalCertificates).values({
      fiscalIdentityId: fiscalIdentityAId,
      encryptedPrivateKey: enc.ciphertext,
      privateKeyIv: enc.iv,
      privateKeyAuthTag: enc.authTag,
      certificate: certPem,
      certificateFingerprint: 'dummy-fingerprint',
      active: true
    });

    // Crear Punto de Venta 1
    await db.insert(pointsOfSale).values({
      fiscalIdentityId: fiscalIdentityAId,
      number: 1,
      type: 'ELECTRONICA',
      active: true
    });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await app.close();
    await closeDatabaseConnection();
  });

  it('1. Creación de Borrador Local (Factura B a Consumidor Final sin tocar ARCA)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/invoices/drafts',
      headers: { 'x-api-key': tenantAKey },
      payload: {
        fiscalIdentityId: fiscalIdentityAId,
        pointOfSaleNumber: 1,
        voucherType: 6, // Factura B
        pricesIncludeVat: true,
        items: [
          {
            description: 'Café Grano 1kg',
            quantity: 1,
            unitPrice: 1210,
            vatRate: 21.0
          },
          {
            description: 'Panificado 1kg',
            quantity: 1,
            unitPrice: 1105,
            vatRate: 10.5
          }
        ]
      }
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe('DRAFT');
    expect(body.voucherNumber).toBeNull();
    expect(body.totalAmount).toBe('2315.00');
    expect(body.netTaxedAmount).toBe('2000.00');
    expect(body.vatAmount).toBe('315.00');
    expect(body.customerName).toBe('Consumidor Final');
    expect(body.customerDocType).toBe(99);
    expect(body.items).toHaveLength(2);
    expect(body.vatSubtotals).toHaveLength(2);
  });

  it('2. Validaciones Fiscales: Factura A rechaza clientes sin CUIT válido', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/invoices/drafts',
      headers: { 'x-api-key': tenantAKey },
      payload: {
        fiscalIdentityId: fiscalIdentityAId,
        pointOfSaleNumber: 1,
        voucherType: 1, // Factura A
        customer: {
          docType: 96, // DNI (inválido para Factura A)
          docNumber: '35123456',
          name: 'Cliente DNI'
        },
        items: [{ description: 'Item 1', quantity: 1, unitPrice: 1000 }]
      }
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('exigen identificar al comprador con CUIT (DocTipo 80)');
  });

  it('3. Validaciones Fiscales: Nota de Crédito exige comprobante asociado', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/invoices/drafts',
      headers: { 'x-api-key': tenantAKey },
      payload: {
        fiscalIdentityId: fiscalIdentityAId,
        pointOfSaleNumber: 1,
        voucherType: 8, // Nota de Crédito B
        items: [{ description: 'Devolución', quantity: 1, unitPrice: 500 }]
      }
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('exigen indicar al menos un comprobante asociado');
  });

  it('4. Emisión Real de Factura Electrónica con CAE ante WSFEv1', async () => {
    // Espiar y mockear llamadas a ARCA
    vi.spyOn(WsaaClient, 'getTicket').mockResolvedValue({
      token: 'mock-wsaa-token-123',
      sign: 'mock-wsaa-sign-456',
      expirationTime: new Date(Date.now() + 3600000),
      fromCache: false
    });

    vi.spyOn(Wsfev1Client, 'getUltimoComprobante').mockResolvedValue(100);

    vi.spyOn(Wsfev1Client, 'solicitarCae').mockResolvedValue({
      resultado: 'A',
      cae: '74123456789012',
      caeFchVto: '20261102',
      cbteDesde: 101,
      cbteHasta: 101,
      cbteFch: '20261023',
      observaciones: [],
      errores: [],
      eventos: [],
      xmlRequest: '<mock-request />',
      xmlResponse: '<mock-response />'
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/invoices',
      headers: {
        'x-api-key': tenantAKey,
        'x-idempotency-key': 'pos-sale-uuid-test-01'
      },
      payload: {
        fiscalIdentityId: fiscalIdentityAId,
        pointOfSaleNumber: 1,
        voucherType: 6, // Factura B
        pricesIncludeVat: true,
        items: [
          {
            description: 'Combo Hamburguesa Clásica',
            quantity: 2,
            unitPrice: 1500, // 2 x 1500 = 3000
            vatRate: 21.0
          }
        ]
      }
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe('AUTHORIZED');
    expect(body.voucherNumber).toBe(101);
    expect(body.cae).toBe('74123456789012');
    expect(body.afipResult).toBe('A');
    expect(body.qrData).toContain('https://www.afip.gob.ar/fe/qr/?p=');
  });

  it('5. IDEMPOTENCIA: Reintento con misma clave de idempotencia retorna la misma factura sin llamar a ARCA', async () => {
    // Espía para verificar que solicitarCae NO se vuelva a llamar
    const solicitarSpy = vi.spyOn(Wsfev1Client, 'solicitarCae');
    solicitarSpy.mockClear();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/invoices',
      headers: {
        'x-api-key': tenantAKey,
        'x-idempotency-key': 'pos-sale-uuid-test-01' // Misma clave
      },
      payload: {
        fiscalIdentityId: fiscalIdentityAId,
        pointOfSaleNumber: 1,
        voucherType: 6,
        items: [{ description: 'Combo Hamburguesa Clásica', quantity: 2, unitPrice: 1500 }]
      }
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.voucherNumber).toBe(101);
    expect(body.cae).toBe('74123456789012');
    expect(solicitarSpy).not.toHaveBeenCalled();
  });

  it('6. MANEJO DE CORTE DE CONEXIÓN Y RECONCILIACIÓN AUTOMÁTICA', async () => {
    vi.spyOn(WsaaClient, 'getTicket').mockResolvedValue({
      token: 'mock-wsaa-token-123',
      sign: 'mock-wsaa-sign-456',
      expirationTime: new Date(Date.now() + 3600000),
      fromCache: true
    });

    vi.spyOn(Wsfev1Client, 'getUltimoComprobante').mockResolvedValue(101);

    // Simular corte de red o timeout
    vi.spyOn(Wsfev1Client, 'solicitarCae').mockRejectedValue(
      new InfrastructureError('Timeout al conectar con WSFEv1 (25000ms)')
    );

    // Intento de emisión que sufre timeout
    const resTimeout = await app.inject({
      method: 'POST',
      url: '/api/v1/invoices',
      headers: { 'x-api-key': tenantAKey },
      payload: {
        fiscalIdentityId: fiscalIdentityAId,
        pointOfSaleNumber: 1,
        voucherType: 6,
        items: [{ description: 'Gaseosa 500ml', quantity: 1, unitPrice: 500 }]
      }
    });

    expect(resTimeout.statusCode).toBe(502);
    expect(resTimeout.json().message).toContain('PENDING_RECONCILIATION');

    // Listar facturas y verificar que existe una en PENDING_RECONCILIATION
    const listRes = await app.inject({
      method: 'GET',
      url: '/api/v1/invoices?status=PENDING_RECONCILIATION',
      headers: { 'x-api-key': tenantAKey }
    });

    expect(listRes.statusCode).toBe(200);
    const pendingList = listRes.json().data;
    expect(pendingList).toHaveLength(1);
    const pendingInvoiceId = pendingList[0].id;
    expect(pendingList[0].voucherNumber).toBe(102);

    // Simular que el worker de reconciliación consulta ARCA (FECompConsultar) y descubre que ARCA sí la autorizó
    vi.spyOn(Wsfev1Client, 'consultarComprobante').mockResolvedValue({
      encontrado: true,
      resultado: 'A',
      cae: '74999999999999',
      caeFchVto: '20261102',
      cbteDesde: 102,
      cbteHasta: 102,
      cbteFch: '20261023',
      impTotal: 500,
      impNeto: 413.22,
      impIVA: 86.78,
      docTipo: 99,
      docNro: '0',
      observaciones: [],
      errores: []
    });

    const reconcileRes = await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${pendingInvoiceId}/reconcile`,
      headers: { 'x-api-key': tenantAKey }
    });

    expect(reconcileRes.statusCode).toBe(200);
    const reconciled = reconcileRes.json();
    expect(reconciled.status).toBe('AUTHORIZED');
    expect(reconciled.cae).toBe('74999999999999');
    expect(reconciled.qrData).toContain('https://www.afip.gob.ar/fe/qr/?p=');
  });

  it('7. AISLAMIENTO MULTI-TENANT: Comercio B NO puede consultar ni reconciliar facturas del Comercio A', async () => {
    // Obtener la factura autorizada del Comercio A
    const listA = await app.inject({
      method: 'GET',
      url: '/api/v1/invoices',
      headers: { 'x-api-key': tenantAKey }
    });
    const invoiceAId = listA.json().data[0].id;

    // Comercio B intenta ver el detalle por ID
    const resGetB = await app.inject({
      method: 'GET',
      url: `/api/v1/invoices/${invoiceAId}`,
      headers: { 'x-api-key': tenantBKey }
    });
    expect(resGetB.statusCode).toBe(404);

    // Comercio B no debe ver facturas en su listado
    const listB = await app.inject({
      method: 'GET',
      url: '/api/v1/invoices',
      headers: { 'x-api-key': tenantBKey }
    });
    expect(listB.statusCode).toBe(200);
    expect(listB.json().data).toHaveLength(0);
  });
});
