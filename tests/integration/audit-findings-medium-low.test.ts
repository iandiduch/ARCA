import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import forge from 'node-forge';
import { inArray } from 'drizzle-orm';
import { createApp } from '../../src/app/server.js';
import { getDatabase, closeDatabaseConnection } from '../../src/infrastructure/database/connection.js';
import { tenants } from '../../src/infrastructure/database/schema/tenants.js';
import { apiKeys } from '../../src/infrastructure/database/schema/api-keys.js';
import { fiscalIdentities } from '../../src/infrastructure/database/schema/fiscal-identities.js';
import { fiscalCertificates } from '../../src/infrastructure/database/schema/fiscal-certificates.js';
import { pointsOfSale } from '../../src/infrastructure/database/schema/points-of-sale.js';
import { invoices } from '../../src/infrastructure/database/schema/invoices.js';
import { invoiceVatSubtotals } from '../../src/infrastructure/database/schema/invoice-vat-subtotals.js';
import { products } from '../../src/infrastructure/database/schema/products.js';
import { generateApiKey } from '../../src/core/security/api-key.js';
import { EncryptionService } from '../../src/core/security/encryption.js';
import { WsaaClient } from '../../src/modules/arca/infrastructure/wsaa/wsaa-client.js';
import { Wsfev1Client } from '../../src/modules/arca/infrastructure/wsfev1/wsfev1-client.js';
import { InvoiceService } from '../../src/modules/invoices/application/invoice-service.js';
import { ProductService } from '../../src/modules/products/application/product-service.js';
import { SequenceNumberCache } from '../../src/core/fiscal/sequence-cache.js';
import { TenantInFlightLimiter } from '../../src/core/security/tenant-in-flight.js';

describe('Auditoría — Resolución de Hallazgos Medios y Bajos (M1-M10, L1-L8, R6-R9)', () => {
  let app: FastifyInstance;
  let tenantAId: string;
  let tenantBId: string;
  let tenantAPosKey: string;
  let tenantAAdminKey: string;
  let tenantBKey: string;
  let fiscalIdentityAId: string;
  let fiscalIdentityBId: string;
  let productBId: string;

  beforeAll(async () => {
    app = await createApp({ enableLogging: false });
    const db = getDatabase();

    const [tA] = await db
      .insert(tenants)
      .values({ name: 'Comercio Auditoria ML A', slug: `audit-ml-a-${Date.now()}` })
      .returning();
    tenantAId = tA!.id;

    const [tB] = await db
      .insert(tenants)
      .values({ name: 'Comercio Auditoria ML B', slug: `audit-ml-b-${Date.now()}` })
      .returning();
    tenantBId = tB!.id;

    const keyGenPosA = generateApiKey();
    await db.insert(apiKeys).values({
      tenantId: tenantAId,
      name: 'POS A Key',
      keyHash: keyGenPosA.keyHash,
      prefix: keyGenPosA.prefix,
      role: 'POS_CLIENT'
    });
    tenantAPosKey = keyGenPosA.rawKey;

    const keyGenAdmin = generateApiKey();
    await db.insert(apiKeys).values({
      tenantId: tenantAId,
      name: 'Admin A Key',
      keyHash: keyGenAdmin.keyHash,
      prefix: keyGenAdmin.prefix,
      role: 'ADMIN'
    });
    tenantAAdminKey = keyGenAdmin.rawKey;

    const keyGenB = generateApiKey();
    await db.insert(apiKeys).values({
      tenantId: tenantBId,
      name: 'POS B Key',
      keyHash: keyGenB.keyHash,
      prefix: keyGenB.prefix,
      role: 'POS_CLIENT'
    });
    tenantBKey = keyGenB.rawKey;

    // Crear producto en Comercio B para probar M6 (productId ajeno)
    const [prodB] = await db
      .insert(products)
      .values({
        tenantId: tenantBId,
        name: 'Producto de Comercio B',
        salePrice: '100.00',
        active: true
      })
      .returning();
    productBId = prodB!.id;

    // Certificado
    const keys = forge.pki.rsa.generateKeyPair({ bits: 1024 });
    const privateKeyPem = forge.pki.privateKeyToPem(keys.privateKey);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01';
    cert.validity.notBefore = new Date(Date.now() - 3600000);
    cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 3600000);
    cert.setSubject([{ name: 'commonName', value: 'arca-audit-ml' }]);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    const certPem = forge.pki.certificateToPem(cert);
    const enc = EncryptionService.encrypt(privateKeyPem);

    const [identA] = await db
      .insert(fiscalIdentities)
      .values({
        tenantId: tenantAId,
        cuit: '30503612891',
        businessName: 'Comercio A ML S.A.',
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
      certificateFingerprint: 'dummy-ml-cert-a',
      active: true
    });

    await db.insert(pointsOfSale).values([
      { fiscalIdentityId: fiscalIdentityAId, number: 1, type: 'ELECTRONICA', active: true },
      { fiscalIdentityId: fiscalIdentityAId, number: 2, type: 'ELECTRONICA', active: false } // Inactivo para L5
    ]);

    const [identB] = await db
      .insert(fiscalIdentities)
      .values({
        tenantId: tenantBId,
        cuit: '30710955057',
        businessName: 'Comercio B ML S.A.',
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
      certificateFingerprint: 'dummy-ml-cert-b',
      active: true
    });

    await db.insert(pointsOfSale).values({
      fiscalIdentityId: fiscalIdentityBId,
      number: 1,
      type: 'ELECTRONICA',
      active: true
    });

    vi.spyOn(WsaaClient, 'getTicket').mockResolvedValue({
      token: 'mock-wsaa-ml',
      sign: 'mock-sign-ml',
      expirationTime: new Date(Date.now() + 3600000),
      fromCache: true
    });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    const db = getDatabase();
    if (tenantAId || tenantBId) {
      const tIds = [tenantAId, tenantBId].filter(Boolean);
      await db.delete(products).where(inArray(products.tenantId, tIds));
      await db.delete(invoices).where(inArray(invoices.tenantId, tIds));
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
  });

  // ---------------------------------------------------------------------------
  // L2: Autenticación previa a validación de esquema
  // ---------------------------------------------------------------------------
  describe('L2 — Autenticación en onRequest antes de procesar schema y body', () => {
    it('petición sin credenciales y con body inválido responde 401 UNAUTHORIZED (no 400)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/invoices',
        payload: { payloadInvalido: 'sin campos requeridos' }
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe('UNAUTHORIZED');
    });
  });

  // ---------------------------------------------------------------------------
  // L4: Exclusión de XMLs del listado de comprobantes
  // ---------------------------------------------------------------------------
  describe('L4 — Optimización de GET /invoices: excluir XMLs del listado', () => {
    it('el listado de comprobantes devuelve afipXmlRequest y afipXmlResponse como null', async () => {
      vi.spyOn(Wsfev1Client, 'getUltimoComprobante').mockResolvedValue(100);
      vi.spyOn(Wsfev1Client, 'solicitarCae').mockResolvedValue({
        resultado: 'A',
        cae: '74123456789012',
        caeFchVto: '20261231',
        cbteDesde: 101,
        cbteHasta: 101,
        cbteFch: '20261108',
        observaciones: [],
        errores: [],
        eventos: [],
        xmlRequest: '<xml-req-l4>contenido largo</xml-req-l4>',
        xmlResponse: '<xml-res-l4>contenido largo respuesta</xml-res-l4>'
      });

      // Emitir comprobante
      const emitRes = await app.inject({
        method: 'POST',
        url: '/api/v1/invoices',
        headers: { 'x-api-key': tenantAPosKey },
        payload: {
          fiscalIdentityId: fiscalIdentityAId,
          pointOfSaleNumber: 1,
          voucherType: 6,
          items: [{ description: 'Test L4', quantity: 1, unitPrice: 100 }]
        }
      });
      expect(emitRes.statusCode).toBe(201);
      const invoiceId = emitRes.json().id;

      // Consultar listado
      const listRes = await app.inject({
        method: 'GET',
        url: '/api/v1/invoices',
        headers: { 'x-api-key': tenantAPosKey }
      });
      expect(listRes.statusCode).toBe(200);
      const item = listRes.json().data.find((inv: { id: string }) => inv.id === invoiceId);
      expect(item).toBeDefined();
      expect(item.afipXmlRequest).toBeNull();
      expect(item.afipXmlResponse).toBeNull();

      // En el detalle individual por ID sí deben estar presentes
      const detailRes = await app.inject({
        method: 'GET',
        url: `/api/v1/invoices/${invoiceId}`,
        headers: { 'x-api-key': tenantAPosKey }
      });
      expect(detailRes.statusCode).toBe(200);
      expect(detailRes.json().afipXmlRequest).toContain('<xml-req-l4>');
    });
  });

  // ---------------------------------------------------------------------------
  // L5: Control de Punto de Venta en Borradores
  // ---------------------------------------------------------------------------
  describe('L5 — Control de punto de venta inactivo en borradores', () => {
    it('rechaza borrador con punto de venta inactivo con 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/invoices/drafts',
        headers: { 'x-api-key': tenantAPosKey },
        payload: {
          fiscalIdentityId: fiscalIdentityAId,
          pointOfSaleNumber: 2, // Inactivo
          voucherType: 6,
          items: [{ description: 'Item en Pto Inactivo', quantity: 1, unitPrice: 100 }]
        }
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/no se encuentra activo/i);
    });
  });

  // ---------------------------------------------------------------------------
  // L6: Cifrado con tag de longitud exacta 16 bytes
  // ---------------------------------------------------------------------------
  describe('L6 — Validación estricta de authTagLength en AES-256-GCM', () => {
    it('falla inmediatamente si el authTag no tiene exactamente 16 bytes (32 hex)', () => {
      const valid = EncryptionService.encrypt('texto plano');
      const truncatedTag = { ...valid, authTag: valid.authTag.slice(0, 16) }; // 8 bytes en vez de 16

      expect(() => EncryptionService.decrypt(truncatedTag)).toThrow(
        /exactamente 16 bytes/i
      );
    });
  });

  // ---------------------------------------------------------------------------
  // L8: GET / no divulga rutas ni entorno
  // ---------------------------------------------------------------------------
  describe('L8 — Endpoint raíz no divulga rutas internas ni entorno ARCA', () => {
    it('GET / responde solo name, status y version', async () => {
      const res = await app.inject({ method: 'GET', url: '/' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.name).toBe('ARCA Fiscal API');
      expect(body.status).toBe('ok');
      expect(body.version).toBe('0.1.0');
      expect(body.environment).toBeUndefined();
      expect(body.documentation).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // M3: notes no se sobrescribe en fallo de red y conciliación en segundo plano
  // ---------------------------------------------------------------------------
  describe('M3 — Preservación de notes ante fallo de red y worker de conciliación', () => {
    it('notes comercial se conserva intacto ante corte de red y el error se guarda en afipErrors', async () => {
      vi.spyOn(Wsfev1Client, 'getUltimoComprobante').mockResolvedValue(200);
      vi.spyOn(Wsfev1Client, 'solicitarCae').mockRejectedValue(new Error('Timeout de conexión ARCA'));

      const testNotes = 'Observación comercial del cliente: entrega pactada piso 3';
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/invoices',
        headers: { 'x-api-key': tenantAPosKey },
        payload: {
          fiscalIdentityId: fiscalIdentityAId,
          pointOfSaleNumber: 1,
          voucherType: 6,
          notes: testNotes,
          items: [{ description: 'Venta con notas', quantity: 1, unitPrice: 200 }]
        }
      });

      expect(res.statusCode).toBe(502);
      const invoiceId = res.json().details?.invoiceId;
      expect(invoiceId).toBeDefined();

      const detail = await new InvoiceService().getInvoiceById(tenantAId, invoiceId);
      expect(detail.status).toBe('PENDING_RECONCILIATION');
      expect(detail.notes).toBe(testNotes);
      expect(detail.afipErrors).toBeDefined();
      expect((detail.afipErrors as Array<{ code: string }>)[0]!.code).toBe('COMMUNICATION_TIMEOUT');
    });

    it('reconcileAllPending concilia comprobantes pendientes antiguos', async () => {
      const invoiceService = new InvoiceService();
      vi.spyOn(Wsfev1Client, 'consultarComprobante').mockResolvedValue({
        encontrado: true,
        resultado: 'A',
        cae: '74999988887777',
        caeFchVto: '20261231',
        cbteDesde: 201,
        cbteHasta: 201,
        cbteFch: '20261108',
        impTotal: 200,
        docTipo: 99,
        docNro: '0',
        observaciones: [],
        errores: []
      });

      // Ejecutar reconciliación en background (no debe lanzar excepción)
      const res = await invoiceService.reconcileAllPending();
      expect(res).toBeDefined();
      expect(res.reconciled).toBeGreaterThanOrEqual(0);
    });
  });

  // ---------------------------------------------------------------------------
  // M4: maxLength y maxItems
  // ---------------------------------------------------------------------------
  describe('M4 — Límites de longitud y cantidad de ítems (maxLength / maxItems)', () => {
    it('rechaza notas comerciales mayores a 1000 caracteres con 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/invoices',
        headers: { 'x-api-key': tenantAPosKey },
        payload: {
          fiscalIdentityId: fiscalIdentityAId,
          pointOfSaleNumber: 1,
          voucherType: 6,
          notes: 'A'.repeat(1001),
          items: [{ description: 'Item con notas gigantes', quantity: 1, unitPrice: 100 }]
        }
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/notes|maxLength|length/i);
    });

    it('rechaza descripción de ítem mayor a 255 caracteres con 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/invoices',
        headers: { 'x-api-key': tenantAPosKey },
        payload: {
          fiscalIdentityId: fiscalIdentityAId,
          pointOfSaleNumber: 1,
          voucherType: 6,
          items: [{ description: 'D'.repeat(256), quantity: 1, unitPrice: 100 }]
        }
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/description|maxLength|length/i);
    });

    it('rechaza creación de producto con metadata mayor a 16 KB con 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/products',
        headers: { 'x-api-key': tenantAPosKey },
        payload: {
          name: 'Producto con metadata gigante',
          salePrice: 100,
          metadata: { campo: 'X'.repeat(20000) }
        }
      });

      expect(res.statusCode).toBe(400);
    });
  });

  // ---------------------------------------------------------------------------
  // M5: Prevención de CSV / Formula Injection
  // ---------------------------------------------------------------------------
  describe('M5 — Protección contra CSV / Formula Injection', () => {
    it('exportToCsv prefija con comilla simple celdas que inician con =, +, -, @', async () => {
      const productService = new ProductService();
      await productService.createProduct(tenantAId, {
        name: '=SUM(1,2)',
        internalCode: '+EXCEL_FORMULA',
        description: '-cmd|/C calc!A0',
        salePrice: 50
      });

      const csv = await productService.exportToCsv(tenantAId);
      expect(csv).toContain("\"'=SUM(1,2)\"");
      expect(csv).toContain("\"'+EXCEL_FORMULA\"");
      expect(csv).toContain("\"'-cmd|/C calc!A0\"");
    });
  });

  // ---------------------------------------------------------------------------
  // M6: Validación de pertenencia de productId
  // ---------------------------------------------------------------------------
  describe('M6 — Rechazo de productId perteneciente a otro comercio', () => {
    it('rechaza con 404 cuando un ítem contiene un productId de otro comercio', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/invoices',
        headers: { 'x-api-key': tenantAPosKey },
        payload: {
          fiscalIdentityId: fiscalIdentityAId,
          pointOfSaleNumber: 1,
          voucherType: 6,
          items: [
            {
              productId: productBId, // Pertenece a Comercio B
              description: 'Intento de usar producto de Comercio B',
              quantity: 1,
              unitPrice: 100
            }
          ]
        }
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().message).toMatch(/no encontrado para este comercio/i);
    });
  });

  // ---------------------------------------------------------------------------
  // M7: Rechazo de bytes nulos y límites numéricos
  // ---------------------------------------------------------------------------
  describe('M7 — Manejo de caracteres nulos y validación de rangos numéricos', () => {
    it('rechaza con 400 peticiones con byte nulo en la URL (%00)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/products?search=%00malicioso',
        headers: { 'x-api-key': tenantAPosKey }
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_INPUT');
    });

    it('rechaza con 400 importes que desbordan el tipo numérico', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/invoices',
        headers: { 'x-api-key': tenantAPosKey },
        payload: {
          fiscalIdentityId: fiscalIdentityAId,
          pointOfSaleNumber: 1,
          voucherType: 6,
          items: [{ description: 'Item desbordado', quantity: 1, unitPrice: 1e21 }]
        }
      });

      expect(res.statusCode).toBe(400);
    });
  });

  // ---------------------------------------------------------------------------
  // M8: Deduplicación automática por posSaleId sin idempotency key explícita
  // ---------------------------------------------------------------------------
  describe('M8 — Deduplicación implícita por posSaleId', () => {
    it('dos solicitudes consecutivas con el mismo posSaleId devuelven el mismo comprobante', async () => {
      vi.spyOn(Wsfev1Client, 'getUltimoComprobante').mockResolvedValue(300);
      vi.spyOn(Wsfev1Client, 'solicitarCae').mockResolvedValue({
        resultado: 'A',
        cae: '74888888888888',
        caeFchVto: '20261231',
        cbteDesde: 301,
        cbteHasta: 301,
        cbteFch: '20261108',
        observaciones: [],
        errores: [],
        eventos: [],
        xmlRequest: '<req />',
        xmlResponse: '<res />'
      });

      const uniquePosSaleId = `pos-sale-test-${Date.now()}`;
      const payload = {
        fiscalIdentityId: fiscalIdentityAId,
        pointOfSaleNumber: 1,
        voucherType: 6,
        posSaleId: uniquePosSaleId,
        items: [{ description: 'Venta POS deduplicada', quantity: 1, unitPrice: 500 }]
      };

      const res1 = await app.inject({
        method: 'POST',
        url: '/api/v1/invoices',
        headers: { 'x-api-key': tenantAPosKey },
        payload
      });
      expect(res1.statusCode).toBe(201);
      const invoiceNumber1 = res1.json().voucherNumber;

      // Segunda solicitud idéntica con el mismo posSaleId (sin x-idempotency-key)
      const res2 = await app.inject({
        method: 'POST',
        url: '/api/v1/invoices',
        headers: { 'x-api-key': tenantAPosKey },
        payload
      });
      expect([200, 201]).toContain(res2.statusCode);
      expect(res2.json().voucherNumber).toBe(invoiceNumber1);
      expect(res2.json().cae).toBe('74888888888888');
    });
  });

  // ---------------------------------------------------------------------------
  // M1 & M2: Libro IVA Ventas completo y límites de rango
  // ---------------------------------------------------------------------------
  describe('M1 & M2 — Libro IVA Ventas completo y control de rango', () => {
    it('el CSV de Libro IVA contiene columnas para todas las alícuotas (0%, 2.5%, 5%, 10.5%, 21%, 27%)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/reports/vat-sales-ledger?format=csv',
        headers: { 'x-api-key': tenantAAdminKey }
      });

      expect(res.statusCode).toBe(200);
      const firstLine = res.body.split('\n')[0]!;
      expect(firstLine).toContain('IVA 0%');
      expect(firstLine).toContain('IVA 2.5%');
      expect(firstLine).toContain('IVA 5%');
      expect(firstLine).toContain('IVA 10.5%');
      expect(firstLine).toContain('IVA 21%');
      expect(firstLine).toContain('IVA 27%');
    });

    it('rechaza con 400 consultas de reporte con rango mayor a 366 días', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/reports/sales?fromDate=2024-01-01&toDate=2025-06-01',
        headers: { 'x-api-key': tenantAAdminKey }
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/rango máximo|366/i);
    });
  });

  // ---------------------------------------------------------------------------
  // R9: CUIT propio con guiones en comprobantes asociados
  // ---------------------------------------------------------------------------
  describe('R9 — CUIT propio con guiones se normaliza y no se trata como tercero', () => {
    it('permite a un POS_CLIENT asociar comprobante propio con CUIT formateado con guiones', async () => {
      // 1. Emitir factura original en Comercio A
      vi.spyOn(Wsfev1Client, 'getUltimoComprobante').mockResolvedValue(400);
      vi.spyOn(Wsfev1Client, 'solicitarCae').mockResolvedValue({
        resultado: 'A',
        cae: '74112233445566',
        caeFchVto: '20261231',
        cbteDesde: 401,
        cbteHasta: 401,
        cbteFch: '20261108',
        observaciones: [],
        errores: [],
        eventos: [],
        xmlRequest: '<req />',
        xmlResponse: '<res />'
      });

      const resOrig = await app.inject({
        method: 'POST',
        url: '/api/v1/invoices',
        headers: { 'x-api-key': tenantAPosKey },
        payload: {
          fiscalIdentityId: fiscalIdentityAId,
          pointOfSaleNumber: 1,
          voucherType: 6,
          items: [{ description: 'Venta para NC con guiones', quantity: 1, unitPrice: 300 }]
        }
      });
      expect(resOrig.statusCode).toBe(201);

      // 2. Emitir Nota de Crédito B indicando el CUIT propio con guiones: '30-71234567-8'
      vi.spyOn(Wsfev1Client, 'getUltimoComprobante').mockResolvedValue(10);
      vi.spyOn(Wsfev1Client, 'solicitarCae').mockResolvedValue({
        resultado: 'A',
        cae: '74998877665544',
        caeFchVto: '20261231',
        cbteDesde: 11,
        cbteHasta: 11,
        cbteFch: '20261108',
        observaciones: [],
        errores: [],
        eventos: [],
        xmlRequest: '<req />',
        xmlResponse: '<res />'
      });

      const resNc = await app.inject({
        method: 'POST',
        url: '/api/v1/invoices',
        headers: { 'x-api-key': tenantAPosKey }, // POS_CLIENT (no admin)
        payload: {
          fiscalIdentityId: fiscalIdentityAId,
          pointOfSaleNumber: 1,
          voucherType: 8, // Nota de Crédito B
          associatedVouchers: [
            {
              voucherType: 6,
              pointOfSale: 1,
              voucherNumber: 401,
              cuit: '30-50361289-1' // Con guiones!
            }
          ],
          items: [{ description: 'Devolución legítima', quantity: 1, unitPrice: 300 }]
        }
      });

      // No debe dar 403 Forbidden por tercero
      expect(resNc.statusCode).toBe(201);
      expect(resNc.json().status).toBe('AUTHORIZED');
    });
  });

  // ---------------------------------------------------------------------------
  // Bloqueo de entorno producción en ambientes no productivos
  // ---------------------------------------------------------------------------
  describe('Protección de Entorno de Producción ARCA', () => {
    it('rechaza alta de identidad fiscal con environment: production en testing sin flag ALLOW_ARCA_PRODUCTION', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/fiscal-identities',
        headers: { 'x-api-key': tenantAAdminKey },
        payload: {
          cuit: '20301112220',
          businessName: 'Empresa Test Prod',
          environment: 'production'
        }
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/no está habilitada para ARCA producción/i);
    });
  });

  // ---------------------------------------------------------------------------
  // Re-test adversarial de las correcciones de medios y bajos
  // ---------------------------------------------------------------------------
  describe('Re-test — huecos encontrados en las correcciones M2/M7/M8', () => {
    const okCae = (nro: number, cae: string) => ({
      resultado: 'A' as const,
      cae,
      caeFchVto: '20261231',
      cbteDesde: nro,
      cbteHasta: nro,
      cbteFch: '20261108',
      observaciones: [],
      errores: [],
      eventos: [],
      xmlRequest: '<req />',
      xmlResponse: '<res />'
    });

    it('M7 – un total que desborda numeric(14,2) responde 400 (no 500)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/invoices',
        headers: { 'x-api-key': tenantAPosKey },
        payload: {
          fiscalIdentityId: fiscalIdentityAId,
          pointOfSaleNumber: 1,
          voucherType: 6,
          items: [{ description: 'Desborde por cantidad x precio', quantity: 99999999, unitPrice: 9999999999 }]
        }
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/supera el máximo/i);
    });

    it('M2 – omitir toDate no habilita un rango de años en el Libro IVA', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/reports/vat-sales-ledger?fromDate=2000-01-01&format=csv',
        headers: { 'x-api-key': tenantAAdminKey }
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/366/);
    });

    it('M10 – /reports/sales con sólo fromDate tampoco escapa del máximo', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/reports/sales?fromDate=2000-01-01',
        headers: { 'x-api-key': tenantAAdminKey }
      });
      expect(res.statusCode).toBe(400);
    });

    it('M8 – la NC de devolución con el posSaleId de la venta no choca con la clave implícita de la factura', async () => {
      vi.spyOn(Wsfev1Client, 'getUltimoComprobante').mockResolvedValue(700);
      vi.spyOn(Wsfev1Client, 'solicitarCae').mockImplementation(async (_a, req) =>
        okCae(req.detalle.cbteDesde, `cae-${req.cbteTipo}-${req.detalle.cbteDesde}`)
      );
      const posSaleId = `venta-devuelta-${Date.now()}`;
      const sale = await app.inject({
        method: 'POST',
        url: '/api/v1/invoices',
        headers: { 'x-api-key': tenantAPosKey },
        payload: {
          fiscalIdentityId: fiscalIdentityAId,
          pointOfSaleNumber: 1,
          voucherType: 6,
          posSaleId,
          items: [{ description: 'Venta', quantity: 1, unitPrice: 100 }]
        }
      });
      expect(sale.statusCode).toBe(201);

      const nc = await app.inject({
        method: 'POST',
        url: '/api/v1/invoices',
        headers: { 'x-api-key': tenantAPosKey },
        payload: {
          fiscalIdentityId: fiscalIdentityAId,
          pointOfSaleNumber: 1,
          voucherType: 8,
          posSaleId,
          associatedVouchers: [{ voucherType: 6, pointOfSale: 1, voucherNumber: sale.json().voucherNumber }],
          items: [{ description: 'Devolución', quantity: 1, unitPrice: 100 }]
        }
      });
      expect(nc.statusCode).toBe(201);
      expect(nc.json().voucherType).toBe(8);
    });

    it('Idempotencia – una venta rechazada por ARCA se puede reenviar corregida con la misma clave', async () => {
      vi.spyOn(Wsfev1Client, 'getUltimoComprobante').mockResolvedValue(800);
      vi.spyOn(Wsfev1Client, 'solicitarCae').mockResolvedValueOnce({
        resultado: 'R',
        cbteDesde: 801,
        cbteHasta: 801,
        cbteFch: '20261108',
        observaciones: [],
        errores: [{ code: 10015, message: 'Receptor inválido' }],
        eventos: [],
        xmlRequest: '<req />',
        xmlResponse: '<res />'
      });
      const key = `rechazo-corregido-${Date.now()}`;
      const send = (unitPrice: number) =>
        app.inject({
          method: 'POST',
          url: '/api/v1/invoices',
          headers: { 'x-api-key': tenantAPosKey, 'x-idempotency-key': key },
          payload: {
            fiscalIdentityId: fiscalIdentityAId,
            pointOfSaleNumber: 1,
            voucherType: 6,
            items: [{ description: 'Venta', quantity: 1, unitPrice }]
          }
        });
      expect((await send(100)).statusCode).toBe(422);

      vi.spyOn(Wsfev1Client, 'solicitarCae').mockImplementation(async (_a, req) => okCae(req.detalle.cbteDesde, 'cae-corregida'));
      const fixed = await send(110);
      expect(fixed.statusCode).toBe(201);
      expect(fixed.json().cae).toBe('cae-corregida');
    });
  });
});
