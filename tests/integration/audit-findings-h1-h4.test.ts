import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import forge from 'node-forge';
import { eq, inArray } from 'drizzle-orm';
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
import { SequenceNumberCache } from '../../src/core/fiscal/sequence-cache.js';
import { TenantInFlightLimiter } from '../../src/core/security/tenant-in-flight.js';
import { clearInProcessQueues } from '../../src/core/security/advisory-lock.js';

describe('Auditoría — Resolución de Hallazgos H1, H2, H3 y H4', () => {
  let app: FastifyInstance;
  let tenantAId: string;
  let tenantBId: string;
  let tenantAPosKey: string;
  let tenantAAdminKey: string;
  let tenantBKey: string;
  let fiscalIdentityAId: string;
  let fiscalIdentityBId: string;

  beforeAll(async () => {
    app = await createApp({ enableLogging: false });
    const db = getDatabase();

    // 1. Crear Tenant A y Tenant B aislados para esta suite de tests
    const [tA] = await db.insert(tenants).values({ name: 'Comercio A', slug: `comercio-a-${Date.now()}` }).returning();
    const [tB] = await db.insert(tenants).values({ name: 'Comercio B', slug: `comercio-b-${Date.now()}` }).returning();
    tenantAId = tA!.id;
    tenantBId = tB!.id;

    // Keys para Comercio A (POS y ADMIN)
    const keyGenPos = generateApiKey();
    await db.insert(apiKeys).values({
      tenantId: tenantAId,
      name: 'POS Key',
      keyHash: keyGenPos.keyHash,
      prefix: keyGenPos.prefix,
      role: 'POS_CLIENT'
    });
    tenantAPosKey = keyGenPos.rawKey;

    const keyGenAdmin = generateApiKey();
    await db.insert(apiKeys).values({
      tenantId: tenantAId,
      name: 'Admin Key',
      keyHash: keyGenAdmin.keyHash,
      prefix: keyGenAdmin.prefix,
      role: 'ADMIN'
    });
    tenantAAdminKey = keyGenAdmin.rawKey;

    // Key para Comercio B (POS)
    const keyGenB = generateApiKey();
    await db.insert(apiKeys).values({
      tenantId: tenantBId,
      name: 'POS B Key',
      keyHash: keyGenB.keyHash,
      prefix: keyGenB.prefix,
      role: 'POS_CLIENT'
    });
    tenantBKey = keyGenB.rawKey;

    // 3. Crear certificado RSA de prueba
    const keys = forge.pki.rsa.generateKeyPair({ bits: 1024 });
    const privateKeyPem = forge.pki.privateKeyToPem(keys.privateKey);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01';
    cert.validity.notBefore = new Date(Date.now() - 3600000);
    cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 3600000);
    cert.setSubject([{ name: 'commonName', value: 'arca-audit-test' }]);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    const certPem = forge.pki.certificateToPem(cert);
    const enc = EncryptionService.encrypt(privateKeyPem);

    // Identidad Fiscal A
    const [identA] = await db
      .insert(fiscalIdentities)
      .values({
        tenantId: tenantAId,
        cuit: '30503612891',
        businessName: 'Comercio A S.R.L.',
        environment: 'homologation',
        status: 'CONNECTED'
      })
      .returning();
    fiscalIdentityAId = identA!.id;

    await db.insert(fiscalCertificates).values({
      fiscalIdentityId: fiscalIdentityAId,
      encryptedPrivateKey: enc.ciphertext,
      privateKeyIv: enc.iv,
      privateKeyAuthTag: enc.authTag,
      certificate: certPem,
      certificateFingerprint: 'dummy-cert-a',
      active: true
    });

    await db.insert(pointsOfSale).values([
      { fiscalIdentityId: fiscalIdentityAId, number: 1, type: 'ELECTRONICA', active: true },
      { fiscalIdentityId: fiscalIdentityAId, number: 2, type: 'ELECTRONICA', active: true },
      { fiscalIdentityId: fiscalIdentityAId, number: 3, type: 'ELECTRONICA', active: true },
      { fiscalIdentityId: fiscalIdentityAId, number: 4, type: 'ELECTRONICA', active: true },
      { fiscalIdentityId: fiscalIdentityAId, number: 9, type: 'ELECTRONICA', active: true }
    ]);

    // Identidad Fiscal B
    const [identB] = await db
      .insert(fiscalIdentities)
      .values({
        tenantId: tenantBId,
        cuit: '30710955057',
        businessName: 'Comercio B S.A.',
        environment: 'homologation',
        status: 'CONNECTED'
      })
      .returning();
    fiscalIdentityBId = identB!.id;

    await db.insert(fiscalCertificates).values({
      fiscalIdentityId: fiscalIdentityBId,
      encryptedPrivateKey: enc.ciphertext,
      privateKeyIv: enc.iv,
      privateKeyAuthTag: enc.authTag,
      certificate: certPem,
      certificateFingerprint: 'dummy-cert-b',
      active: true
    });

    await db.insert(pointsOfSale).values({
      fiscalIdentityId: fiscalIdentityBId,
      number: 1,
      type: 'ELECTRONICA',
      active: true
    });

    // Mocks comunes
    vi.spyOn(WsaaClient, 'getTicket').mockResolvedValue({
      token: 'mock-wsaa-token-audit',
      sign: 'mock-wsaa-sign-audit',
      expirationTime: new Date(Date.now() + 3600000),
      fromCache: true
    });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    const db = getDatabase();
    if (tenantAId || tenantBId) {
      const tIds = [tenantAId, tenantBId].filter(Boolean);
      await db.delete(invoices).where(inArray(invoices.tenantId, tIds));
      await db.delete(idempotencyKeys).where(inArray(idempotencyKeys.tenantId, tIds));
      if (fiscalIdentityAId || fiscalIdentityBId) {
        const fIds = [fiscalIdentityAId, fiscalIdentityBId].filter(Boolean);
        await db.delete(pointsOfSale).where(inArray(pointsOfSale.fiscalIdentityId, fIds));
        await db.delete(fiscalCertificates).where(inArray(fiscalCertificates.fiscalIdentityId, fIds));
      }
      await db.delete(fiscalIdentities).where(inArray(fiscalIdentities.tenantId, tIds));
      await db.delete(apiKeys).where(inArray(apiKeys.tenantId, tIds));
      await db.delete(tenants).where(inArray(tenants.id, tIds));
    }
    await app.close();
    await closeDatabaseConnection();
  });

  beforeEach(() => {
    SequenceNumberCache.clear();
    TenantInFlightLimiter.reset();
    clearInProcessQueues();
  });

  // ---------------------------------------------------------------------------
  // H3: Validación de descuentos excesivos, líneas negativas y totales <= $0.00
  // ---------------------------------------------------------------------------
  describe('H3 — Integridad de Totales, Descuentos y Líneas Negativas', () => {
    it('rechaza con 400 cuando el descuento es mayor al importe del ítem (línea negativa)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/invoices',
        headers: { 'x-api-key': tenantAPosKey },
        payload: {
          fiscalIdentityId: fiscalIdentityAId,
          pointOfSaleNumber: 1,
          voucherType: 6,
          items: [
            { description: 'Producto caro', quantity: 1, unitPrice: 100000, vatRate: 21 },
            { description: 'Descuento oculto', quantity: 1, unitPrice: 0, discount: 99000, vatRate: 21 }
          ]
        }
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/El descuento \(\$99000\) no puede superar el importe del ítem/);
    });

    it('rechaza borrador local con total negativo con 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/invoices/drafts',
        headers: { 'x-api-key': tenantAPosKey },
        payload: {
          fiscalIdentityId: fiscalIdentityAId,
          pointOfSaleNumber: 1,
          voucherType: 6,
          items: [{ description: 'Item negativo', quantity: 1, unitPrice: 10, discount: 1000 }]
        }
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/El descuento \(\$1000\) no puede superar el importe del ítem/);
    });

    it('rechaza comprobante con importe total $0.00 con 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/invoices',
        headers: { 'x-api-key': tenantAPosKey },
        payload: {
          fiscalIdentityId: fiscalIdentityAId,
          pointOfSaleNumber: 1,
          voucherType: 6,
          items: [{ description: 'Muestra gratis', quantity: 0.0001, unitPrice: 1 }]
        }
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/El importe total del comprobante debe ser mayor a cero/);
    });

    it('rechaza borrador con punto de venta no configurado', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/invoices/drafts',
        headers: { 'x-api-key': tenantAPosKey },
        payload: {
          fiscalIdentityId: fiscalIdentityAId,
          pointOfSaleNumber: 777,
          voucherType: 6,
          items: [{ description: 'Venta', quantity: 1, unitPrice: 100 }]
        }
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('El punto de venta 777 no está configurado');
    });
  });

  // ---------------------------------------------------------------------------
  // H4: Control de Notas de Crédito sobre comprobantes asociados
  // ---------------------------------------------------------------------------
  describe('H4 — Control de Notas de Crédito sobre Comprobante Asociado', () => {
    let originalInvoiceNumber: number;

    it('emite una Factura B original para pruebas de NC', async () => {
      vi.spyOn(Wsfev1Client, 'getUltimoComprobante').mockResolvedValue(50);
      vi.spyOn(Wsfev1Client, 'solicitarCae').mockResolvedValue({
        resultado: 'A',
        cae: '74123456789012',
        caeFchVto: '20261118',
        cbteDesde: 51,
        cbteHasta: 51,
        cbteFch: '20261108',
        observaciones: [],
        errores: [],
        eventos: [],
        xmlRequest: '<mock />',
        xmlResponse: '<mock />'
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/invoices',
        headers: { 'x-api-key': tenantAPosKey },
        payload: {
          fiscalIdentityId: fiscalIdentityAId,
          pointOfSaleNumber: 1,
          voucherType: 6, // Factura B
          items: [{ description: 'Venta original', quantity: 1, unitPrice: 1210 }]
        }
      });

      expect(res.statusCode).toBe(201);
      originalInvoiceNumber = res.json().voucherNumber;
      expect(originalInvoiceNumber).toBe(51);
      expect(res.json().totalAmount).toBe('1210.00');
    });

    it('rechaza NC asociada a un comprobante inexistente con 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/invoices',
        headers: { 'x-api-key': tenantAPosKey },
        payload: {
          fiscalIdentityId: fiscalIdentityAId,
          pointOfSaleNumber: 1,
          voucherType: 8, // NC B
          items: [{ description: 'Devolución fantasma', quantity: 1, unitPrice: 500 }],
          associatedVouchers: [{ voucherType: 6, pointOfSale: 1, voucherNumber: 9999999 }]
        }
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('no existe o no se encuentra en estado AUTHORIZED');
    });

    it('rechaza NC de importe mayor al comprobante asociado con 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/invoices',
        headers: { 'x-api-key': tenantAPosKey },
        payload: {
          fiscalIdentityId: fiscalIdentityAId,
          pointOfSaleNumber: 1,
          voucherType: 8, // NC B
          items: [{ description: 'Devolución excesiva', quantity: 1, unitPrice: 5000000 }],
          associatedVouchers: [{ voucherType: 6, pointOfSale: 1, voucherNumber: originalInvoiceNumber }]
        }
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/supera el saldo disponible del comprobante asociado/);
    });

    it('rechaza NC con clase discordante (NC A sobre Factura B) con 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/invoices',
        headers: { 'x-api-key': tenantAPosKey },
        payload: {
          fiscalIdentityId: fiscalIdentityAId,
          pointOfSaleNumber: 1,
          voucherType: 3, // NC A
          customer: { docType: 80, docNumber: '20223626719', taxCondition: 1 },
          items: [{ description: 'Devolución', quantity: 1, unitPrice: 100 }],
          associatedVouchers: [{ voucherType: 6, pointOfSale: 1, voucherNumber: originalInvoiceNumber }]
        }
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/no coincide con la clase del comprobante a emitir/);
    });

    it('rechaza NC asociada a un CUIT ajeno si la API Key es de rol POS_CLIENT (403)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/invoices',
        headers: { 'x-api-key': tenantAPosKey },
        payload: {
          fiscalIdentityId: fiscalIdentityAId,
          pointOfSaleNumber: 1,
          voucherType: 8,
          items: [{ description: 'Devolución cross-cuit', quantity: 1, unitPrice: 100 }],
          associatedVouchers: [{ voucherType: 6, pointOfSale: 1, voucherNumber: 1, cuit: '30710955057' }]
        }
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('FORBIDDEN');
    });

    it('autoriza NC legítima dentro del saldo y descuenta el disponible para la próxima NC', async () => {
      // 1ra NC por $1000 sobre factura de $1210
      vi.spyOn(Wsfev1Client, 'getUltimoComprobante').mockResolvedValue(10);
      vi.spyOn(Wsfev1Client, 'solicitarCae').mockResolvedValue({
        resultado: 'A',
        cae: '74123456789013',
        caeFchVto: '20261118',
        cbteDesde: 11,
        cbteHasta: 11,
        cbteFch: '20261108',
        observaciones: [],
        errores: [],
        eventos: [],
        xmlRequest: '<mock />',
        xmlResponse: '<mock />'
      });

      const nc1 = await app.inject({
        method: 'POST',
        url: '/api/v1/invoices',
        headers: { 'x-api-key': tenantAPosKey },
        payload: {
          fiscalIdentityId: fiscalIdentityAId,
          pointOfSaleNumber: 1,
          voucherType: 8,
          items: [{ description: 'Devolución parcial', quantity: 1, unitPrice: 1000 }],
          associatedVouchers: [{ voucherType: 6, pointOfSale: 1, voucherNumber: originalInvoiceNumber }]
        }
      });
      expect(nc1.statusCode).toBe(201);

      // 2da NC por $300 intenta superar el saldo restante ($1210 - $1000 = $210)
      const nc2 = await app.inject({
        method: 'POST',
        url: '/api/v1/invoices',
        headers: { 'x-api-key': tenantAPosKey },
        payload: {
          fiscalIdentityId: fiscalIdentityAId,
          pointOfSaleNumber: 1,
          voucherType: 8,
          items: [{ description: 'Devolución excede saldo restante', quantity: 1, unitPrice: 300 }],
          associatedVouchers: [{ voucherType: 6, pointOfSale: 1, voucherNumber: originalInvoiceNumber }]
        }
      });
      expect(nc2.statusCode).toBe(400);
      expect(nc2.json().message).toMatch(/supera el saldo disponible del comprobante asociado/);
    });
  });

  // ---------------------------------------------------------------------------
  // H2: Caché de numeración de secuencia & reducción de llamadas a ARCA
  // ---------------------------------------------------------------------------
  describe('H2 — Caché de numeración de secuencia y resolución de error 10016', () => {
    it('la segunda emisión consecutiva reutiliza la numeración cacheada sin consultar FECompUltimoAutorizado', async () => {
      const getUltimoSpy = vi.spyOn(Wsfev1Client, 'getUltimoComprobante').mockResolvedValue(200);
      const solicitarCaeSpy = vi.spyOn(Wsfev1Client, 'solicitarCae').mockImplementation(async (_auth, payload) => ({
        resultado: 'A',
        cae: `cae-${payload.detalle.cbteDesde}`,
        caeFchVto: '20261118',
        cbteDesde: payload.detalle.cbteDesde,
        cbteHasta: payload.detalle.cbteHasta,
        cbteFch: '20261108',
        observaciones: [],
        errores: [],
        eventos: [],
        xmlRequest: '<mock />',
        xmlResponse: '<mock />'
      }));

      // Emisión 1: Caché vacía -> llama a getUltimoComprobante (1 vez)
      const r1 = await app.inject({
        method: 'POST',
        url: '/api/v1/invoices',
        headers: { 'x-api-key': tenantAPosKey },
        payload: {
          fiscalIdentityId: fiscalIdentityAId,
          pointOfSaleNumber: 1,
          voucherType: 6,
          items: [{ description: 'Emisión 1', quantity: 1, unitPrice: 100 }]
        }
      });
      expect(r1.statusCode).toBe(201);
      expect(r1.json().voucherNumber).toBe(201);
      expect(getUltimoSpy).toHaveBeenCalledTimes(1);

      // Emisión 2: Caché poblada -> NO llama a getUltimoComprobante, emite 202 directamente
      const r2 = await app.inject({
        method: 'POST',
        url: '/api/v1/invoices',
        headers: { 'x-api-key': tenantAPosKey },
        payload: {
          fiscalIdentityId: fiscalIdentityAId,
          pointOfSaleNumber: 1,
          voucherType: 6,
          items: [{ description: 'Emisión 2', quantity: 1, unitPrice: 100 }]
        }
      });
      expect(r2.statusCode).toBe(201);
      expect(r2.json().voucherNumber).toBe(202);
      expect(getUltimoSpy).toHaveBeenCalledTimes(1); // ¡Sigue siendo 1! 50% menos llamadas
    });

    it('si ARCA reporta error 10016, invalida caché, consulta getUltimoComprobante y reintenta con éxito', async () => {
      // Simular que la caché local pensaba que el último era 300, pero ARCA en realidad ya va por 305
      const seqKey = SequenceNumberCache.buildKey('homologation:30503612891', 1, 6);
      SequenceNumberCache.set(seqKey, 300);

      const getUltimoSpy = vi.spyOn(Wsfev1Client, 'getUltimoComprobante').mockResolvedValue(305);
      let callCount = 0;
      vi.spyOn(Wsfev1Client, 'solicitarCae').mockImplementation(async (_auth, payload) => {
        callCount++;
        if (payload.detalle.cbteDesde === 301) {
          // ARCA rechaza con 10016
          return {
            resultado: 'R',
            cbteDesde: payload.detalle.cbteDesde,
            cbteHasta: payload.detalle.cbteHasta,
            cbteFch: '20261108',
            observaciones: [],
            errores: [{ code: 10016, message: 'El campo CbteDesde / CbteHasta no es el próximo a autorizar.' }],
            eventos: [],
            xmlRequest: '<mock />',
            xmlResponse: '<mock />'
          };
        }
        // Segundo intento con número 306
        return {
          resultado: 'A',
          cae: 'cae-resincronizado-306',
          caeFchVto: '20261118',
          cbteDesde: payload.detalle.cbteDesde,
          cbteHasta: payload.detalle.cbteHasta,
          cbteFch: '20261108',
          observaciones: [],
          errores: [],
          eventos: [],
          xmlRequest: '<mock />',
          xmlResponse: '<mock />'
        };
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/invoices',
        headers: { 'x-api-key': tenantAPosKey },
        payload: {
          fiscalIdentityId: fiscalIdentityAId,
          pointOfSaleNumber: 1,
          voucherType: 6,
          items: [{ description: 'Venta con reintento automático 10016', quantity: 1, unitPrice: 100 }]
        }
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().voucherNumber).toBe(306);
      expect(callCount).toBe(2);
      expect(getUltimoSpy).toHaveBeenCalledTimes(1);
      // La caché queda actualizada en 306
      expect(SequenceNumberCache.get(seqKey)).toBe(306);
    });
  });

  // ---------------------------------------------------------------------------
  // H1: Prevención de DoS entre Tenants (Inanición por pool de locks)
  // ---------------------------------------------------------------------------
  describe('H1 — Aislamiento de Capacidad entre Tenants (No Starvation)', () => {
    it('un comercio saturando su punto de venta no bloquea la emisión de otro comercio (Tenant B)', async () => {
      // Simular que ARCA tarda 100ms en emitir
      vi.spyOn(Wsfev1Client, 'getUltimoComprobante').mockResolvedValue(500);
      vi.spyOn(Wsfev1Client, 'solicitarCae').mockImplementation(async (_auth, payload) => {
        await new Promise((r) => setTimeout(r, 80));
        return {
          resultado: 'A',
          cae: `cae-${payload.detalle.cbteDesde}`,
          caeFchVto: '20261118',
          cbteDesde: payload.detalle.cbteDesde,
          cbteHasta: payload.detalle.cbteHasta,
          cbteFch: '20261108',
          observaciones: [],
          errores: [],
          eventos: [],
          xmlRequest: '<mock />',
          xmlResponse: '<mock />'
        };
      });

      // El comercio A lanza 8 emisiones simultáneas (supera el límite de emisiones en vuelo = 5)
      const attackerPromises = Array.from({ length: 8 }, (_, i) =>
        app.inject({
          method: 'POST',
          url: '/api/v1/invoices',
          headers: { 'x-api-key': tenantAPosKey },
          payload: {
            fiscalIdentityId: fiscalIdentityAId,
            pointOfSaleNumber: 9,
            voucherType: 6,
            items: [{ description: `Venta A ${i}`, quantity: 1, unitPrice: 50 }]
          }
        })
      );

      // Inmediatamente el comercio B emite en su punto de venta 1
      const victimResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/invoices',
        headers: { 'x-api-key': tenantBKey },
        payload: {
          fiscalIdentityId: fiscalIdentityBId,
          pointOfSaleNumber: 1,
          voucherType: 6,
          items: [{ description: 'Venta legítima Comercio B', quantity: 1, unitPrice: 150 }]
        }
      });

      // Comercio B NO queda bloqueado ni sufre error de pool de conexiones
      expect(victimResponse.statusCode).toBe(201);
      expect(victimResponse.json().status).toBe('AUTHORIZED');

      const attackerResults = await Promise.all(attackerPromises);
      const busyErrors = attackerResults.filter((r) => r.statusCode === 429 || r.statusCode === 503);
      const successes = attackerResults.filter((r) => r.statusCode === 201);

      // Se aplicó el límite de emisiones concurrentes con Retry-After
      expect(busyErrors.length).toBeGreaterThan(0);
      expect(busyErrors[0]!.headers['retry-after']).toBeDefined();
      expect(successes.length).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Verificación de Regresiones y Casos Límite Reportados (Post-H1/H2/H4)
  // ---------------------------------------------------------------------------
  describe('Correcciones Críticas y de Alta Prioridad (Regresiones H1/H2/H4)', () => {
    it('CRÍTICO – Si el reintento de 10016 sufre corte de red, queda PENDING_RECONCILIATION y el reintento del POS concilia sin duplicar facturas', async () => {
      const seqKey = SequenceNumberCache.buildKey('homologation:30503612891', 1, 6);
      SequenceNumberCache.set(seqKey, 400); // En caché pensamos que el último es 400

      // ARCA ya va por 404
      vi.spyOn(Wsfev1Client, 'getUltimoComprobante').mockResolvedValue(404);

      let attempts = 0;
      vi.spyOn(Wsfev1Client, 'solicitarCae').mockImplementation(async (_auth, payload) => {
        attempts++;
        if (payload.detalle.cbteDesde === 401) {
          // Intento inicial con número viejo falla con 10016
          return {
            resultado: 'R',
            cbteDesde: payload.detalle.cbteDesde,
            cbteHasta: payload.detalle.cbteHasta,
            cbteFch: '20261108',
            observaciones: [],
            errores: [{ code: 10016, message: 'El campo CbteDesde no es el próximo a autorizar.' }],
            eventos: [],
            xmlRequest: '<mock />',
            xmlResponse: '<mock />'
          };
        }
        // Segundo intento con 405 sufre caída de red / timeout
        throw new Error('ETIMEDOUT: Connection reset by ARCA gateway');
      });

      const idempotencyKey = `idemp-10016-double-${Date.now()}`;
      const payload = {
        fiscalIdentityId: fiscalIdentityAId,
        pointOfSaleNumber: 1,
        voucherType: 6,
        idempotencyKey,
        items: [{ description: 'Venta única POS', quantity: 1, unitPrice: 500 }]
      };

      // 1. Primer envío del POS: falla en el segundo solicitarCae
      const res1 = await app.inject({
        method: 'POST',
        url: '/api/v1/invoices',
        headers: { 'x-api-key': tenantAPosKey },
        payload
      });

      // El POS recibe error de contingencia / infraestructura
      expect([500, 502, 503, 504]).toContain(res1.statusCode);

      // Verificar que el comprobante quedó en la BD como PENDING_RECONCILIATION con número 405 (no 401)
      const db = getDatabase();
      const allWithKey = await db
        .select()
        .from(invoices)
        .where(eq(invoices.idempotencyKey, idempotencyKey));
      expect(allWithKey.length).toBe(1);
      expect(allWithKey[0]!.status).toBe('PENDING_RECONCILIATION');
      expect(allWithKey[0]!.voucherNumber).toBe(405);

      // 2. Simular que ARCA en realidad SÍ había recibido y autorizado la factura 405
      vi.spyOn(Wsfev1Client, 'consultarComprobante').mockResolvedValue({
        encontrado: true,
        resultado: 'A',
        cae: 'cae-recon-405-exitoso',
        caeFchVto: '20261118',
        cbteDesde: 405,
        cbteHasta: 405,
        cbteFch: '20261108',
        impTotal: 500,
        impNeto: 413.22,
        impIVA: 86.78,
        docTipo: 99,
        docNro: '0',
        observaciones: [],
        errores: []
      });

      // 3. El POS reintenta con la MISMA idempotencyKey
      const res2 = await app.inject({
        method: 'POST',
        url: '/api/v1/invoices',
        headers: { 'x-api-key': tenantAPosKey },
        payload
      });

      // Debe retornar 200 o 201 con la factura 405 autorizada
      expect([200, 201]).toContain(res2.statusCode);
      expect(res2.json().voucherNumber).toBe(405);
      expect(res2.json().cae).toBe('cae-recon-405-exitoso');
      expect(res2.json().status).toBe('AUTHORIZED');

      // VERIFICACIÓN CRÍTICA: En la BD sigue existiendo exactamente 1 comprobante para esa idempotencyKey.
      // NUNCA se emitió un comprobante 406 duplicado.
      const afterRetry = await db
        .select()
        .from(invoices)
        .where(eq(invoices.idempotencyKey, idempotencyKey));
      expect(afterRetry.length).toBe(1);
      expect(afterRetry[0]!.voucherNumber).toBe(405);
      expect(afterRetry[0]!.status).toBe('AUTHORIZED');
    });

    it('ALTO – Rechazo por límite de emisiones en vuelo NO bloquea la idempotencyKey durante 24 horas', async () => {
      // Simular que el tenant ya alcanzó el límite saturando manualmente el limiter
      const inFlightLimit = 5;
      for (let i = 0; i < inFlightLimit; i++) {
        TenantInFlightLimiter.tryAcquire(tenantAId, inFlightLimit);
      }

      const testKey = `key-test-limiter-no-block-${Date.now()}`;
      const payload = {
        fiscalIdentityId: fiscalIdentityAId,
        pointOfSaleNumber: 1,
        voucherType: 6,
        idempotencyKey: testKey,
        items: [{ description: 'Venta con key', quantity: 1, unitPrice: 200 }]
      };

      // 1. Envío mientras el tenant está saturado
      const resBlocked = await app.inject({
        method: 'POST',
        url: '/api/v1/invoices',
        headers: { 'x-api-key': tenantAPosKey },
        payload
      });

      expect(resBlocked.statusCode).toBe(429);
      expect(resBlocked.headers['retry-after']).toBeDefined();

      // 2. Liberar el limiter (terminaron las emisiones concurrentes)
      for (let i = 0; i < inFlightLimit; i++) {
        TenantInFlightLimiter.release(tenantAId);
      }

      // 3. El POS reintenta con la MISMA idempotencyKey
      vi.spyOn(Wsfev1Client, 'getUltimoComprobante').mockResolvedValue(600);
      vi.spyOn(Wsfev1Client, 'solicitarCae').mockResolvedValue({
        resultado: 'A',
        cae: 'cae-limiter-ok',
        caeFchVto: '20261118',
        cbteDesde: 601,
        cbteHasta: 601,
        cbteFch: '20261108',
        observaciones: [],
        errores: [],
        eventos: [],
        xmlRequest: '<mock />',
        xmlResponse: '<mock />'
      });

      const resRetry = await app.inject({
        method: 'POST',
        url: '/api/v1/invoices',
        headers: { 'x-api-key': tenantAPosKey },
        payload
      });

      // No devuelve 409 Conflict: la key se procesa exitosamente
      expect(resRetry.statusCode).toBe(201);
      expect(resRetry.json().status).toBe('AUTHORIZED');
      expect(resRetry.json().voucherNumber).toBe(601);
    });

    it('ALTO – 4 Notas de Crédito simultáneas desde puntos de venta distintos se serializan y no sobre-acreditan la factura', async () => {
      // 1. Crear y autorizar Factura original de $1.210 en PtoVta 1
      vi.spyOn(Wsfev1Client, 'getUltimoComprobante').mockResolvedValue(700);
      vi.spyOn(Wsfev1Client, 'solicitarCae').mockResolvedValue({
        resultado: 'A',
        cae: 'cae-fac-701',
        caeFchVto: '20261118',
        cbteDesde: 701,
        cbteHasta: 701,
        cbteFch: '20261108',
        observaciones: [],
        errores: [],
        eventos: [],
        xmlRequest: '<mock />',
        xmlResponse: '<mock />'
      });

      const facRes = await app.inject({
        method: 'POST',
        url: '/api/v1/invoices',
        headers: { 'x-api-key': tenantAPosKey },
        payload: {
          fiscalIdentityId: fiscalIdentityAId,
          pointOfSaleNumber: 1,
          voucherType: 6,
          pricesIncludeVat: false,
          items: [{ description: 'Producto original', quantity: 1, unitPrice: 1000, vatRate: 21 }]
        }
      });
      expect(facRes.statusCode).toBe(201);
      const facTotal = Number(facRes.json().totalAmount);
      expect(facTotal).toBe(1210);

      // 2. Simular latencia en solicitarCae para forzar concurrencia real
      vi.spyOn(Wsfev1Client, 'solicitarCae').mockImplementation(async (_auth, payload) => {
        await new Promise((r) => setTimeout(r, 60));
        return {
          resultado: 'A',
          cae: `cae-nc-${payload.detalle.cbteDesde}`,
          caeFchVto: '20261118',
          cbteDesde: payload.detalle.cbteDesde,
          cbteHasta: payload.detalle.cbteHasta,
          cbteFch: '20261108',
          observaciones: [],
          errores: [],
          eventos: [],
          xmlRequest: '<mock />',
          xmlResponse: '<mock />'
        };
      });

      // 3. Emitir simultáneamente 4 Notas de Crédito de $1.210 cada una,
      // desde 4 puntos de venta DISTINTOS (1, 2, 3, 4) todas sobre la misma Factura 1-701
      const ncPtovtas = [1, 2, 3, 4];
      const ncPromises = ncPtovtas.map((ptoVta) =>
        app.inject({
          method: 'POST',
          url: '/api/v1/invoices',
          headers: { 'x-api-key': tenantAPosKey },
          payload: {
            fiscalIdentityId: fiscalIdentityAId,
            pointOfSaleNumber: ptoVta,
            voucherType: 8, // Nota de Crédito B
            pricesIncludeVat: false,
            items: [{ description: 'Devolución total', quantity: 1, unitPrice: 1000, vatRate: 21 }],
            associatedVouchers: [
              {
                pointOfSale: 1,
                voucherType: 6,
                voucherNumber: 701
              }
            ]
          }
        })
      );

      const ncResults = await Promise.all(ncPromises);

      const authorized = ncResults.filter((r) => r.statusCode === 201);
      const rejected = ncResults.filter((r) => r.statusCode === 400);

      // EXACTAMENTE UNA Nota de Crédito es autorizada ($1.210 acreditados = 100% del saldo)
      expect(authorized.length).toBe(1);
      // Las otras tres son rechazadas porque el saldo quedó en $0
      expect(rejected.length).toBe(3);
      for (const rej of rejected) {
        expect(rej.json().message).toMatch(/supera el saldo disponible/i);
      }
    });

    it('ALTO – Notas de Crédito en PENDING_RECONCILIATION consumen saldo y bloquean nuevas emisiones', async () => {
      // 1. Factura original autorizada por $1.210 (PtoVta 1, número 801)
      vi.spyOn(Wsfev1Client, 'getUltimoComprobante').mockResolvedValue(800);
      vi.spyOn(Wsfev1Client, 'solicitarCae').mockResolvedValue({
        resultado: 'A',
        cae: 'cae-fac-801',
        caeFchVto: '20261118',
        cbteDesde: 801,
        cbteHasta: 801,
        cbteFch: '20261108',
        observaciones: [],
        errores: [],
        eventos: [],
        xmlRequest: '<mock />',
        xmlResponse: '<mock />'
      });

      const facRes = await app.inject({
        method: 'POST',
        url: '/api/v1/invoices',
        headers: { 'x-api-key': tenantAPosKey },
        payload: {
          fiscalIdentityId: fiscalIdentityAId,
          pointOfSaleNumber: 1,
          voucherType: 6,
          items: [{ description: 'Producto 800', quantity: 1, unitPrice: 1000, vatRate: 21 }]
        }
      });
      expect(facRes.statusCode).toBe(201);

      // 2. Emitir Nota de Crédito 1 por $1.210 que sufre caída de red -> queda PENDING_RECONCILIATION
      vi.spyOn(Wsfev1Client, 'solicitarCae').mockRejectedValue(new Error('Connection timeout to ARCA'));

      const nc1Res = await app.inject({
        method: 'POST',
        url: '/api/v1/invoices',
        headers: { 'x-api-key': tenantAPosKey },
        payload: {
          fiscalIdentityId: fiscalIdentityAId,
          pointOfSaleNumber: 1,
          voucherType: 8,
          items: [{ description: 'Devolución total interrumpida', quantity: 1, unitPrice: 1000, vatRate: 21 }],
          associatedVouchers: [{ pointOfSale: 1, voucherType: 6, voucherNumber: 801 }]
        }
      });
      expect([500, 502, 503, 504]).toContain(nc1Res.statusCode);

      // 3. Intentar emitir una segunda Nota de Crédito por $500 sobre la misma factura
      // Debe ser rechazada porque la NC en PENDING_RECONCILIATION ya reservó el saldo
      const nc2Res = await app.inject({
        method: 'POST',
        url: '/api/v1/invoices',
        headers: { 'x-api-key': tenantAPosKey },
        payload: {
          fiscalIdentityId: fiscalIdentityAId,
          pointOfSaleNumber: 1,
          voucherType: 8,
          items: [{ description: 'Segunda NC', quantity: 1, unitPrice: 413.22, vatRate: 21 }],
          associatedVouchers: [{ pointOfSale: 1, voucherType: 6, voucherNumber: 801 }]
        }
      });

      expect(nc2Res.statusCode).toBe(400);
      expect(nc2Res.json().message).toMatch(/supera el saldo disponible/i);
    });

    it('ALTO – Rechaza con 400 emitir una Nota de Crédito asociada a otra Nota de Crédito previa', async () => {
      // 1. Factura autorizada
      vi.spyOn(Wsfev1Client, 'getUltimoComprobante').mockResolvedValue(900);
      vi.spyOn(Wsfev1Client, 'solicitarCae').mockResolvedValue({
        resultado: 'A',
        cae: 'cae-fac-901',
        caeFchVto: '20261118',
        cbteDesde: 901,
        cbteHasta: 901,
        cbteFch: '20261108',
        observaciones: [],
        errores: [],
        eventos: [],
        xmlRequest: '<mock />',
        xmlResponse: '<mock />'
      });

      const facRes = await app.inject({
        method: 'POST',
        url: '/api/v1/invoices',
        headers: { 'x-api-key': tenantAPosKey },
        payload: {
          fiscalIdentityId: fiscalIdentityAId,
          pointOfSaleNumber: 1,
          voucherType: 6,
          items: [{ description: 'Venta 900', quantity: 1, unitPrice: 1000, vatRate: 21 }]
        }
      });
      expect(facRes.statusCode).toBe(201);

      // 2. Primera Nota de Crédito autorizada sobre la Factura
      vi.spyOn(Wsfev1Client, 'getUltimoComprobante').mockResolvedValue(50);
      vi.spyOn(Wsfev1Client, 'solicitarCae').mockResolvedValue({
        resultado: 'A',
        cae: 'cae-nc-51',
        caeFchVto: '20261118',
        cbteDesde: 51,
        cbteHasta: 51,
        cbteFch: '20261108',
        observaciones: [],
        errores: [],
        eventos: [],
        xmlRequest: '<mock />',
        xmlResponse: '<mock />'
      });

      const nc1Res = await app.inject({
        method: 'POST',
        url: '/api/v1/invoices',
        headers: { 'x-api-key': tenantAPosKey },
        payload: {
          fiscalIdentityId: fiscalIdentityAId,
          pointOfSaleNumber: 1,
          voucherType: 8,
          items: [{ description: 'Devolución parcial', quantity: 1, unitPrice: 400, vatRate: 21 }],
          associatedVouchers: [{ pointOfSale: 1, voucherType: 6, voucherNumber: 901 }]
        }
      });
      expect(nc1Res.statusCode).toBe(201);
      expect(nc1Res.json().voucherNumber).toBe(51);

      // 3. Intentar emitir una segunda Nota de Crédito asociando a la Nota de Crédito (tipo 8, número 51)
      const ncOnNcRes = await app.inject({
        method: 'POST',
        url: '/api/v1/invoices',
        headers: { 'x-api-key': tenantAPosKey },
        payload: {
          fiscalIdentityId: fiscalIdentityAId,
          pointOfSaleNumber: 1,
          voucherType: 8,
          items: [{ description: 'NC sobre NC ilegal', quantity: 1, unitPrice: 100, vatRate: 21 }],
          associatedVouchers: [{ pointOfSale: 1, voucherType: 8, voucherNumber: 51 }]
        }
      });

      expect(ncOnNcRes.statusCode).toBe(400);
      expect(ncOnNcRes.json().message).toMatch(/No se permite emitir una Nota de Crédito sobre otra Nota de Crédito/i);
    });

    // -------------------------------------------------------------------------
    // N1: Prevención de DoS por acumulación de comprobantes asociados y locks
    // -------------------------------------------------------------------------
    it('N1 – Rechaza de inmediato con 400 notas de crédito con más de 5 comprobantes asociados sin tomar locks', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/invoices',
        headers: { 'x-api-key': tenantAPosKey },
        payload: {
          fiscalIdentityId: fiscalIdentityAId,
          pointOfSaleNumber: 1,
          voucherType: 8,
          items: [{ description: 'Devolución', quantity: 1, unitPrice: 100, vatRate: 21 }],
          associatedVouchers: Array.from({ length: 15 }, (_, i) => ({
            pointOfSale: 1,
            voucherType: 6,
            voucherNumber: 100 + i
          }))
        }
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/more than 5 items|No se permite indicar más de 5 comprobantes asociados/i);
    });

    it('N1 – Rechaza comprobantes asociados inexistentes antes de adquirir bloqueos', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/invoices',
        headers: { 'x-api-key': tenantAPosKey },
        payload: {
          fiscalIdentityId: fiscalIdentityAId,
          pointOfSaleNumber: 1,
          voucherType: 8,
          items: [{ description: 'Devolución inventada', quantity: 1, unitPrice: 100, vatRate: 21 }],
          associatedVouchers: [
            { pointOfSale: 1, voucherType: 6, voucherNumber: 888888 },
            { pointOfSale: 1, voucherType: 6, voucherNumber: 888889 }
          ]
        }
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/no existe o no se encuentra en estado AUTHORIZED/i);
    });

    // -------------------------------------------------------------------------
    // N2: Integridad estricta en conciliación y manejo de desincronización 10016
    // -------------------------------------------------------------------------
    it('N2 – Si falla la consulta de último comprobante tras error 10016, marca el registro como REJECTED y libera numeración', async () => {
      const seqKey = SequenceNumberCache.buildKey('homologation:30503612891', 1, 6);
      SequenceNumberCache.set(seqKey, 2000);

      vi.spyOn(Wsfev1Client, 'solicitarCae').mockResolvedValue({
        resultado: 'R',
        cbteDesde: 2001,
        cbteHasta: 2001,
        cbteFch: '20261108',
        observaciones: [],
        errores: [{ code: 10016, message: 'El campo CbteDesde no es el próximo a autorizar.' }],
        eventos: [],
        xmlRequest: '<mock />',
        xmlResponse: '<mock />'
      });

      // Simular que falla la consulta a getUltimoComprobante
      vi.spyOn(Wsfev1Client, 'getUltimoComprobante').mockRejectedValue(new Error('ARCA gateway connection timed out'));

      const idempKey = `idemp-n2-10016-fail-${Date.now()}`;
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/invoices',
        headers: { 'x-api-key': tenantAPosKey },
        payload: {
          fiscalIdentityId: fiscalIdentityAId,
          pointOfSaleNumber: 1,
          voucherType: 6,
          idempotencyKey: idempKey,
          items: [{ description: 'Venta con desincronización', quantity: 1, unitPrice: 500 }]
        }
      });

      expect([422, 500, 502]).toContain(res.statusCode);

      // En la base de datos debe quedar marcado como REJECTED con voucherNumber null (NO como PENDING)
      const db = getDatabase();
      const [inv] = await db.select().from(invoices).where(eq(invoices.idempotencyKey, idempKey));
      expect(inv).toBeDefined();
      expect(inv.status).toBe('REJECTED');
      expect(inv.voucherNumber).toBeNull();
    });

    it('N2 – Conciliación rechaza comprobante de ARCA si el importe o receptor no coincide con la venta local', async () => {
      // 1. Insertar una factura local que quedó pendiente de reconciliación por $5.000
      const db = getDatabase();
      const [localDraft] = await db
        .insert(invoices)
        .values({
          tenantId: tenantAId,
          fiscalIdentityId: fiscalIdentityAId,
          pointOfSaleNumber: 1,
          voucherType: 6,
          voucherLetter: 'B',
          voucherNumber: 3001,
          status: 'PENDING_RECONCILIATION',
          totalAmount: '5000.00',
          netTaxedAmount: '4132.23',
          netUntaxedAmount: '0.00',
          exemptAmount: '0.00',
          vatAmount: '867.77',
          specialTaxesAmount: '0.00',
          customerDocType: 99,
          customerDocNumber: '0',
          customerName: 'Consumidor Final',
          customerTaxCondition: 5,
          concept: 1
        })
        .returning();

      // 2. Simular que en ARCA el comprobante 3001 pertenece a otra transacción (emitido por otro sistema por $1)
      vi.spyOn(Wsfev1Client, 'consultarComprobante').mockResolvedValue({
        encontrado: true,
        resultado: 'A',
        cae: 'cae-de-otro-sistema-1234',
        caeFchVto: '20261118',
        cbteDesde: 3001,
        cbteHasta: 3001,
        cbteFch: '20261108',
        impTotal: 1, // $1 en ARCA vs $5.000 local
        impNeto: 0.83,
        impIVA: 0.17,
        docTipo: 80,
        docNro: '30503612891',
        observaciones: [],
        errores: []
      });

      // 3. Intentar conciliar la factura
      const reconRes = await app.inject({
        method: 'POST',
        url: `/api/v1/invoices/${localDraft!.id}/reconcile`,
        headers: { 'x-api-key': tenantAAdminKey }
      });

      // Debe responder con 409 Conflict indicando que no corresponde a esta venta
      expect(reconRes.statusCode).toBe(409);
      expect(reconRes.json().message).toMatch(/no corresponde a esta venta/i);

      // El comprobante local debe ser marcado como REJECTED y liberar el voucherNumber
      const [updated] = await db.select().from(invoices).where(eq(invoices.id, localDraft!.id));
      expect(updated.status).toBe('REJECTED');
      expect(updated.voucherNumber).toBeNull();
    });

    // -------------------------------------------------------------------------
    // N3: Reutilización de Idempotency-Key con payload distinto responde 422
    // -------------------------------------------------------------------------
    it('N3 – Reutilizar una idempotencyKey con otra venta devuelve 422 y no la factura vieja', async () => {
      vi.spyOn(Wsfev1Client, 'getUltimoComprobante').mockResolvedValue(4000);
      vi.spyOn(Wsfev1Client, 'solicitarCae').mockResolvedValue({
        resultado: 'A',
        cae: 'cae-n3-4001',
        caeFchVto: '20261118',
        cbteDesde: 4001,
        cbteHasta: 4001,
        cbteFch: '20261108',
        observaciones: [],
        errores: [],
        eventos: [],
        xmlRequest: '<mock />',
        xmlResponse: '<mock />'
      });

      const keyN3 = `key-n3-distinct-payload-${Date.now()}`;

      // 1. Primera venta legítima por $1.210
      const res1 = await app.inject({
        method: 'POST',
        url: '/api/v1/invoices',
        headers: { 'x-api-key': tenantAPosKey },
        payload: {
          fiscalIdentityId: fiscalIdentityAId,
          pointOfSaleNumber: 1,
          voucherType: 6,
          idempotencyKey: keyN3,
          items: [{ description: 'Venta inicial', quantity: 1, unitPrice: 1210 }]
        }
      });
      expect(res1.statusCode).toBe(201);
      expect(Number(res1.json().totalAmount)).toBe(1210);

      // 2. Segunda venta enviada con la MISMA key pero con importe y contenido completamente distinto ($99.999)
      const res2 = await app.inject({
        method: 'POST',
        url: '/api/v1/invoices',
        headers: { 'x-api-key': tenantAPosKey },
        payload: {
          fiscalIdentityId: fiscalIdentityAId,
          pointOfSaleNumber: 1,
          voucherType: 6,
          idempotencyKey: keyN3,
          items: [{ description: 'Venta distinta cara', quantity: 1, unitPrice: 99999 }]
        }
      });

      // Debe responder 422 IDEMPOTENCY_KEY_MISMATCH y NO 201 con la factura vieja de $1.210
      expect(res2.statusCode).toBe(422);
      expect(res2.json().code).toBe('IDEMPOTENCY_KEY_MISMATCH');
    });

    // -------------------------------------------------------------------------
    // N2b + N2c: la solicitud se pierde sin llegar a ARCA y otro sistema toma ese número con una venta
    // IDÉNTICA (mismo importe, Consumidor Final). FchProceso delata que es ajeno; el reintento factura la venta.
    // -------------------------------------------------------------------------
    it('N2b/N2c – No adopta el CAE de una venta idéntica de otro sistema y el reintento con la misma key factura', async () => {
      vi.spyOn(Wsfev1Client, 'getUltimoComprobante').mockResolvedValue(5000);
      const solicitar = vi.spyOn(Wsfev1Client, 'solicitarCae').mockRejectedValueOnce(new Error('ETIMEDOUT: solicitud no procesada'));

      const idempotencyKey = `n2b-${Date.now()}`;
      const payload = {
        fiscalIdentityId: fiscalIdentityAId,
        pointOfSaleNumber: 1,
        voucherType: 6,
        idempotencyKey,
        items: [{ description: 'Venta mostrador', quantity: 1, unitPrice: 500 }]
      };

      const res1 = await app.inject({ method: 'POST', url: '/api/v1/invoices', headers: { 'x-api-key': tenantAPosKey }, payload });
      expect(res1.statusCode).toBe(502);

      // Otro sistema autorizó el 5001 una hora antes de nuestra solicitud, con los mismos importes y receptor
      const arTime = (d: Date) => new Date(d.getTime() - 3 * 3600_000).toISOString().replace(/\D/g, '').slice(0, 14);
      vi.spyOn(Wsfev1Client, 'consultarComprobante').mockResolvedValue({
        encontrado: true,
        resultado: 'A',
        cae: 'cae-de-otro-sistema',
        caeFchVto: '20261118',
        cbteDesde: 5001,
        cbteHasta: 5001,
        cbteFch: '20261108',
        impTotal: 500,
        impNeto: 413.22,
        impIVA: 86.78,
        docTipo: 99,
        docNro: '0',
        fchProceso: arTime(new Date(Date.now() - 3600_000)),
        observaciones: [],
        errores: []
      });
      vi.spyOn(Wsfev1Client, 'getUltimoComprobante').mockResolvedValue(5001);
      solicitar.mockImplementation(async (_auth, req) => ({
        resultado: 'A',
        cae: `cae-propio-${req.detalle.cbteDesde}`,
        caeFchVto: '20261118',
        cbteDesde: req.detalle.cbteDesde,
        cbteHasta: req.detalle.cbteHasta,
        cbteFch: '20261108',
        observaciones: [],
        errores: [],
        eventos: [],
        xmlRequest: '<mock />',
        xmlResponse: '<mock />'
      }));

      const res2 = await app.inject({ method: 'POST', url: '/api/v1/invoices', headers: { 'x-api-key': tenantAPosKey }, payload });
      expect(res2.statusCode).toBe(201);
      expect(res2.json().voucherNumber).toBe(5002);
      expect(res2.json().cae).toBe('cae-propio-5002');

      const rows = await getDatabase().select().from(invoices).where(eq(invoices.idempotencyKey, idempotencyKey));
      expect(rows.some((r) => r.cae === 'cae-de-otro-sistema')).toBe(false);
      expect(rows.filter((r) => r.status === 'AUTHORIZED')).toHaveLength(1);
      expect(rows.find((r) => r.status === 'REJECTED')?.voucherNumber).toBeNull();
    });

    it('N2b – Con FchProceso dentro de la ventana de la solicitud sí concilia el CAE (respuesta perdida propia)', async () => {
      vi.spyOn(Wsfev1Client, 'getUltimoComprobante').mockResolvedValue(6000);
      vi.spyOn(Wsfev1Client, 'solicitarCae').mockRejectedValueOnce(new Error('ETIMEDOUT: respuesta perdida'));
      const idempotencyKey = `n2b-own-${Date.now()}`;
      const payload = {
        fiscalIdentityId: fiscalIdentityAId,
        pointOfSaleNumber: 1,
        voucherType: 6,
        idempotencyKey,
        items: [{ description: 'Venta mostrador', quantity: 1, unitPrice: 500 }]
      };
      expect((await app.inject({ method: 'POST', url: '/api/v1/invoices', headers: { 'x-api-key': tenantAPosKey }, payload })).statusCode).toBe(502);

      const arNow = new Date(Date.now() - 3 * 3600_000).toISOString().replace(/\D/g, '').slice(0, 14);
      vi.spyOn(Wsfev1Client, 'consultarComprobante').mockResolvedValue({
        encontrado: true, resultado: 'A', cae: 'cae-propio-6001', caeFchVto: '20261118', cbteDesde: 6001, cbteHasta: 6001,
        cbteFch: '20261108', impTotal: 500, impNeto: 413.22, impIVA: 86.78, docTipo: 99, docNro: '0', fchProceso: arNow,
        observaciones: [], errores: []
      });
      const res2 = await app.inject({ method: 'POST', url: '/api/v1/invoices', headers: { 'x-api-key': tenantAPosKey }, payload });
      expect(res2.statusCode).toBeLessThan(300);
      expect(res2.json().voucherNumber).toBe(6001);
      expect(res2.json().cae).toBe('cae-propio-6001');
    });
  });
});
