import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import forge from 'node-forge';
import { createApp } from '../../src/app/server.js';
import { closeDatabaseConnection, getDatabase } from '../../src/infrastructure/database/connection.js';
import { loadConfig } from '../../src/app/config.js';
import { fiscalCertificates } from '../../src/infrastructure/database/schema/fiscal-certificates.js';
import { invoices } from '../../src/infrastructure/database/schema/invoices.js';
import { eq } from 'drizzle-orm';
import { EncryptionService } from '../../src/core/security/encryption.js';

describe('Identidades Fiscales y Asistente ARCA (Fase 4)', () => {
  let app: FastifyInstance;
  const config = loadConfig();

  let tenantAKey: string;
  let tenantBKey: string;
  let tenantAId: string;
  let identityAId: string;

  beforeAll(async () => {
    app = await createApp({ enableLogging: false });
    await app.ready();

    // Crear dos tenants para verificar aislamiento
    const resA = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: { 'x-api-key': config.API_KEY_MASTER },
      payload: { name: 'Comercio Fiscal A', slug: `fiscal-test-a-${Date.now()}` }
    });
    const tenantA = resA.json();
    tenantAId = tenantA.id;

    const keyResA = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${tenantA.id}/api-keys`,
      headers: { 'x-api-key': config.API_KEY_MASTER },
      payload: { name: 'Key A' }
    });
    tenantAKey = keyResA.json().rawKey;

    const resB = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: { 'x-api-key': config.API_KEY_MASTER },
      payload: { name: 'Comercio Fiscal B', slug: `fiscal-test-b-${Date.now()}` }
    });
    const tenantB = resB.json();

    const keyResB = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${tenantB.id}/api-keys`,
      headers: { 'x-api-key': config.API_KEY_MASTER },
      payload: { name: 'Key B' }
    });
    tenantBKey = keyResB.json().rawKey;
  });

  afterAll(async () => {
    await app.close();
    await closeDatabaseConnection();
  });

  it('1. Paso 1: Registrar CUIT e identidad fiscal', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/fiscal-identities',
      headers: { 'x-api-key': tenantAKey },
      payload: {
        cuit: '30503612891',
        businessName: 'Servicios Generales S.A.',
        environment: 'homologation',
        connectionType: 'OWN_CERTIFICATE'
      }
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBeDefined();
    expect(body.cuit).toBe('30503612891');
    expect(body.status).toBe('IDENTITY_PENDING');
    identityAId = body.id;
  });

  it('2. Paso 2: Generar automáticamente clave privada RSA 2048 y solicitud CSR', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/fiscal-identities/${identityAId}/certificate-requests`,
      headers: { 'x-api-key': tenantAKey }
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.csrPem).toContain('-----BEGIN CERTIFICATE REQUEST-----');
    expect(body.instructions).toBeDefined();

    // Verificar en base de datos que la clave privada está CIFRADA
    const db = getDatabase();
    const [certRecord] = await db
      .select()
      .from(fiscalCertificates)
      .where(eq(fiscalCertificates.fiscalIdentityId, identityAId))
      .limit(1);

    expect(certRecord).toBeDefined();
    expect(certRecord!.encryptedPrivateKey).not.toContain('BEGIN RSA PRIVATE KEY');
    expect(certRecord!.privateKeyIv).toBeDefined();
    expect(certRecord!.privateKeyAuthTag).toBeDefined();

    // Comprobar que el estado de la identidad avanzó a CERTIFICATE_PENDING
    const statusRes = await app.inject({
      method: 'GET',
      url: `/api/v1/fiscal-identities/${identityAId}/status`,
      headers: { 'x-api-key': tenantAKey }
    });
    expect(statusRes.json().status).toBe('CERTIFICATE_PENDING');
  });

  it('3. Paso 4: Rechazar certificado que no coincide con la clave privada generada', async () => {
    // Crear un certificado con OTRA clave ajena
    const foreignKeys = forge.pki.rsa.generateKeyPair({ bits: 2048, workers: -1 });
    const foreignCert = forge.pki.createCertificate();
    foreignCert.publicKey = foreignKeys.publicKey;
    foreignCert.serialNumber = '999';
    foreignCert.validity.notBefore = new Date();
    foreignCert.validity.notAfter = new Date(Date.now() + 3600000);
    foreignCert.sign(foreignKeys.privateKey, forge.md.sha256.create());
    const foreignCertPem = forge.pki.certificateToPem(foreignCert);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/fiscal-identities/${identityAId}/certificates`,
      headers: { 'x-api-key': tenantAKey },
      payload: { certificatePem: foreignCertPem }
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('no corresponde a la clave privada');
  });

  it('4. Paso 4: Cargar y validar certificado correcto correspondiente a la clave privada', async () => {
    // Obtener la clave privada generada desde la base de datos desencriptándola
    const db = getDatabase();
    const [certRecord] = await db
      .select()
      .from(fiscalCertificates)
      .where(eq(fiscalCertificates.fiscalIdentityId, identityAId))
      .limit(1);

    const privateKeyPem = EncryptionService.decrypt({
      ciphertext: certRecord!.encryptedPrivateKey,
      iv: certRecord!.privateKeyIv,
      authTag: certRecord!.privateKeyAuthTag
    });

    const privateKey = forge.pki.privateKeyFromPem(privateKeyPem);
    const publicKey = forge.pki.setRsaPublicKey(privateKey.n, privateKey.e);

    // Crear certificado emitido con la clave pública correcta
    const matchingCert = forge.pki.createCertificate();
    matchingCert.publicKey = publicKey;
    matchingCert.serialNumber = '1001';
    matchingCert.validity.notBefore = new Date(Date.now() - 3600000);
    matchingCert.validity.notAfter = new Date(Date.now() + 365 * 24 * 3600000);
    matchingCert.setSubject([{ name: 'commonName', value: 'computador1' }]);
    matchingCert.sign(privateKey, forge.md.sha256.create());
    const matchingCertPem = forge.pki.certificateToPem(matchingCert);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/fiscal-identities/${identityAId}/certificates`,
      headers: { 'x-api-key': tenantAKey },
      payload: { certificatePem: matchingCertPem }
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.metadata.isExpired).toBe(false);
    expect(body.metadata.fingerprint).toHaveLength(64);

    // Estado debe avanzar a AUTHORIZATION_PENDING
    const statusRes = await app.inject({
      method: 'GET',
      url: `/api/v1/fiscal-identities/${identityAId}/status`,
      headers: { 'x-api-key': tenantAKey }
    });
    expect(statusRes.json().status).toBe('AUTHORIZATION_PENDING');
    expect(statusRes.json().hasCertificate).toBe(true);
  });

  it('5. AISLAMIENTO: Comercio B NO puede acceder ni operar sobre identidades del Comercio A', async () => {
    // Comercio B intenta consultar el estado
    const resGet = await app.inject({
      method: 'GET',
      url: `/api/v1/fiscal-identities/${identityAId}/status`,
      headers: { 'x-api-key': tenantBKey }
    });
    expect(resGet.statusCode).toBe(404);

    // Comercio B intenta generar CSR en identidad de Comercio A
    const resCsr = await app.inject({
      method: 'POST',
      url: `/api/v1/fiscal-identities/${identityAId}/certificate-requests`,
      headers: { 'x-api-key': tenantBKey }
    });
    expect(resCsr.statusCode).toBe(404);
  });

  it('6. AISLAMIENTO: Comercio B NO puede eliminar identidades del Comercio A', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/fiscal-identities/${identityAId}`,
      headers: { 'x-api-key': tenantBKey }
    });

    expect(res.statusCode).toBe(404);
  });

  it('7. Eliminar una identidad fiscal sin comprobantes emitidos', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/fiscal-identities',
      headers: { 'x-api-key': tenantAKey },
      payload: {
        cuit: '30712345671',
        businessName: 'Comercio Descartable SRL',
        environment: 'homologation'
      }
    });
    expect(createRes.statusCode).toBe(201);
    const throwawayId = createRes.json().id;

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/fiscal-identities/${throwawayId}`,
      headers: { 'x-api-key': tenantAKey }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().message).toContain('eliminada');

    // Ya no debe existir
    const statusRes = await app.inject({
      method: 'GET',
      url: `/api/v1/fiscal-identities/${throwawayId}/status`,
      headers: { 'x-api-key': tenantAKey }
    });
    expect(statusRes.statusCode).toBe(404);
  });

  it('8. Rechazar la eliminacion de una identidad con comprobantes emitidos', async () => {
    const db = getDatabase();
    await db.insert(invoices).values({
      tenantId: tenantAId,
      fiscalIdentityId: identityAId,
      pointOfSaleNumber: 1,
      voucherType: 6,
      voucherLetter: 'B',
      totalAmount: '100.00'
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/fiscal-identities/${identityAId}`,
      headers: { 'x-api-key': tenantAKey }
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain('comprobante');

    // La identidad debe seguir existiendo
    const statusRes = await app.inject({
      method: 'GET',
      url: `/api/v1/fiscal-identities/${identityAId}/status`,
      headers: { 'x-api-key': tenantAKey }
    });
    expect(statusRes.statusCode).toBe(200);
  });
});
