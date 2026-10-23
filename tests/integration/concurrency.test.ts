import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../../src/app/server.js';
import { getDatabase, closeDatabaseConnection } from '../../src/infrastructure/database/connection.js';
import forge from 'node-forge';
import {
  tenants,
  apiKeys,
  fiscalIdentities,
  fiscalCertificates,
  pointsOfSale,
  invoices
} from '../../src/infrastructure/database/schema/index.js';
import { Wsfev1Client } from '../../src/modules/arca/infrastructure/wsfev1/wsfev1-client.js';
import { WsaaClient } from '../../src/modules/arca/infrastructure/wsaa/wsaa-client.js';
import { generateApiKey } from '../../src/core/security/api-key.js';
import { EncryptionService } from '../../src/core/security/encryption.js';
import { backupDatabase } from '../../scripts/backup-db.js';
import { restoreDatabase } from '../../scripts/restore-db.js';
import { eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';

describe('Pruebas de Concurrencia, Carga, Seguridad y Respaldo (Fase 8)', () => {
  let app: FastifyInstance;
  const db = getDatabase();

  const tenantSlug = `ferreteria-stress-${Date.now()}`;
  let tenantId: string;
  let tenantApiKey: string;
  let posId: string;
  let identityId: string;

  beforeAll(async () => {
    app = await createApp({ enableLogging: false });
    await app.ready();

    // 1. Crear Tenant
    const [t] = await db
      .insert(tenants)
      .values({
        name: 'Ferretería Stress & Load Test',
        slug: tenantSlug,
        status: 'ACTIVE'
      })
      .returning();
    tenantId = t.id;

    // 2. Crear API Key
    const keyGen = generateApiKey();
    await db.insert(apiKeys).values({
      tenantId,
      name: 'Stress Test Key',
      prefix: keyGen.prefix,
      keyHash: keyGen.keyHash,
      status: 'ACTIVE',
      role: 'ADMIN'
    });
    tenantApiKey = keyGen.rawKey;

    // 3. Crear Identidad Fiscal y Certificado X.509
    const keys = forge.pki.rsa.generateKeyPair({ bits: 1024 });
    const privateKeyPem = forge.pki.privateKeyToPem(keys.privateKey);

    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01';
    cert.validity.notBefore = new Date(Date.now() - 3600000);
    cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 3600000);
    cert.setSubject([{ name: 'commonName', value: 'computador-stress' }]);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    const certPem = forge.pki.certificateToPem(cert);

    const enc = EncryptionService.encrypt(privateKeyPem);
    const [fi] = await db
      .insert(fiscalIdentities)
      .values({
        tenantId,
        cuit: '20223626719',
        businessName: 'Ferretería Stress S.R.L.',
        status: 'CONNECTED',
        environment: 'homologation',
        encryptedPrivateKey: enc.ciphertext,
        privateKeyIv: enc.iv,
        privateKeyAuthTag: enc.authTag,
        certificatePairingVerified: true
      })
      .returning();
    identityId = fi.id;

    await db.insert(fiscalCertificates).values({
      fiscalIdentityId: identityId,
      encryptedPrivateKey: enc.ciphertext,
      privateKeyIv: enc.iv,
      privateKeyAuthTag: enc.authTag,
      certificate: certPem,
      certificateFingerprint: 'dummy-stress-fingerprint',
      active: true
    });

    // 4. Crear Punto de Venta
    const [pos] = await db
      .insert(pointsOfSale)
      .values({
        fiscalIdentityId: identityId,
        number: 15,
        type: 'ELECTRONICA',
        active: true
      })
      .returning();
    posId = pos.id;

    // Mocks de comunicación externa ARCA
    vi.spyOn(WsaaClient, 'getTicket').mockResolvedValue({
      token: 'mock-wsaa-token',
      sign: 'mock-wsaa-sign',
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
  });

  afterAll(async () => {
    await app.close();
    // Limpiar datos
    await db.delete(invoices).where(eq(invoices.tenantId, tenantId));
    await db.delete(pointsOfSale).where(eq(pointsOfSale.id, posId));
    await db.delete(fiscalCertificates).where(eq(fiscalCertificates.fiscalIdentityId, identityId));
    await db.delete(fiscalIdentities).where(eq(fiscalIdentities.id, identityId));
    await db.delete(apiKeys).where(eq(apiKeys.tenantId, tenantId));
    await db.delete(tenants).where(eq(tenants.id, tenantId));
    await closeDatabaseConnection();
  });

  it('1. Concurrencia de Idempotencia: 10 peticiones simultáneas con la misma Idempotency-Key emiten exactamente 1 comprobante', async () => {
    const idempotencyKey = `concurrency-key-${Date.now()}`;

    const invoicePayload = {
      fiscalIdentityId: identityId,
      pointOfSaleNumber: 15,
      voucherType: 6, // Factura B
      pricesIncludeVat: true,
      items: [
        {
          description: 'Clavo Espiralado 2 pulg',
          quantity: 10,
          unitPrice: 100,
          vatRate: 21.0
        }
      ]
    };

    // Lanzar 10 peticiones en paralelo exacto
    const promises = Array.from({ length: 10 }, () =>
      app.inject({
        method: 'POST',
        url: '/api/v1/invoices',
        headers: {
          'x-api-key': tenantApiKey,
          'x-idempotency-key': idempotencyKey
        },
        payload: invoicePayload
      })
    );

    const responses = await Promise.all(promises);

    // Todas las respuestas deben ser exitosas (201 Created)
    for (const res of responses) {
      expect(res.statusCode).toBe(201);
    }

    // Todas las respuestas deben tener exactamente el mismo invoice ID y CAE
    const firstBody = responses[0].json();
    for (const res of responses) {
      expect(res.json().id).toBe(firstBody.id);
      expect(res.json().cae).toBe(firstBody.cae);
      expect(res.json().voucherNumber).toBe(firstBody.voucherNumber);
    }

    // En la base de datos debe existir ÚNICAMENTE 1 registro para este comprobante
    const dbInvoices = await db
      .select()
      .from(invoices)
      .where(eq(invoices.tenantId, tenantId));

    expect(dbInvoices.length).toBe(1);
    expect(dbInvoices[0].id).toBe(firstBody.id);
  });

  it('2. Respaldo y Restauración de Base de Datos: backupDatabase() y restoreDatabase() conservan integridad total', async () => {
    const tempBackupDir = path.resolve(process.cwd(), 'backups', 'test-run');

    // 1. Tomar snapshot de la base de datos
    const backupRes = await backupDatabase(tempBackupDir);
    expect(fs.existsSync(backupRes.backupPath)).toBe(true);
    expect(backupRes.checksum).toHaveLength(64);
    expect(backupRes.tableCounts.tenants).toBeGreaterThan(0);
    expect(backupRes.tableCounts.invoices).toBeGreaterThan(0);

    // 2. Restaurar sobre la misma base de datos
    const restoreRes = await restoreDatabase(backupRes.backupPath);
    expect(restoreRes.restoredTables.tenants).toBe(backupRes.tableCounts.tenants);
    expect(restoreRes.restoredTables.invoices).toBe(backupRes.tableCounts.invoices);

    // 3. Limpiar directorio temporal
    if (fs.existsSync(tempBackupDir)) {
      fs.rmSync(tempBackupDir, { recursive: true, force: true });
    }
  });

  it('3. Rate Limiting por Inquilino: responder 429 RATE_LIMIT_EXCEEDED al superar el umbral configurado', async () => {
    // Instanciar un Fastify con un límite bajo específico de 3 peticiones
    const limitedApp = await createApp({ enableLogging: false, rateLimitMax: 3 });
    await limitedApp.ready();

    try {
      // Realizar 3 peticiones que deben pasar
      for (let i = 0; i < 3; i++) {
        const okRes = await limitedApp.inject({
          method: 'GET',
          url: '/health/live',
          headers: { 'x-api-key': tenantApiKey }
        });
        expect(okRes.statusCode).toBe(200);
      }

      // La 4ta petición con la misma API Key debe ser rechazada con 429
      const blockedRes = await limitedApp.inject({
        method: 'GET',
        url: '/health/live',
        headers: { 'x-api-key': tenantApiKey }
      });

      expect(blockedRes.statusCode).toBe(429);
      const body = blockedRes.json();
      expect(body.code).toBe('RATE_LIMIT_EXCEEDED');
      expect(body.message).toContain('Has superado el límite');

      // Un comercio distinto con otra API Key NO debe verse afectado
      const otherKeyRes = await limitedApp.inject({
        method: 'GET',
        url: '/health/live',
        headers: { 'x-api-key': 'other-merchant-api-key' }
      });
      expect(otherKeyRes.statusCode).toBe(200);
    } finally {
      await limitedApp.close();
    }
  });
});
