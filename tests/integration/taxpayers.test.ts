import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import forge from 'node-forge';
import { createApp } from '../../src/app/server.js';
import { getDatabase, closeDatabaseConnection } from '../../src/infrastructure/database/connection.js';
import { tenants } from '../../src/infrastructure/database/schema/tenants.js';
import { apiKeys } from '../../src/infrastructure/database/schema/api-keys.js';
import { fiscalIdentities } from '../../src/infrastructure/database/schema/fiscal-identities.js';
import { fiscalCertificates } from '../../src/infrastructure/database/schema/fiscal-certificates.js';
import { generateApiKey } from '../../src/core/security/api-key.js';
import { EncryptionService } from '../../src/core/security/encryption.js';
import { WsaaClient } from '../../src/modules/arca/infrastructure/wsaa/wsaa-client.js';
import { PadronClient } from '../../src/modules/arca/infrastructure/padron/padron-client.js';

describe('Padrón de Contribuyentes ARCA (Fase 7)', () => {
  let app: FastifyInstance;
  let tenantAId: string;
  let tenantBId: string;
  let tenantAKey: string;
  let tenantBKey: string;
  let fiscalIdentityAId: string;

  beforeAll(async () => {
    app = await createApp({ enableLogging: false });
    const db = getDatabase();

    await db.delete(fiscalCertificates);
    await db.delete(fiscalIdentities);
    await db.delete(apiKeys);
    await db.delete(tenants);

    const [tA] = await db.insert(tenants).values({ name: 'Comercio A', slug: `comercio-a-tax-${Date.now()}` }).returning();
    const [tB] = await db.insert(tenants).values({ name: 'Comercio B (Sin Certificado)', slug: `comercio-b-tax-${Date.now()}` }).returning();
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
        businessName: 'Comercio Emisor S.R.L.',
        environment: 'homologation',
        status: 'CONNECTED'
      })
      .returning();
    fiscalIdentityAId = identA!.id;

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
      certificateFingerprint: 'dummy-padron-fp',
      active: true
    });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await app.close();
    await closeDatabaseConnection();
  });

  it('1. GET /api/v1/taxpayers/:cuit - Consulta exitosa en padrón oficial ARCA', async () => {
    vi.spyOn(WsaaClient, 'getTicket').mockResolvedValue({
      token: 'mock-padron-token',
      sign: 'mock-padron-sign',
      expirationTime: new Date(Date.now() + 3600000),
      fromCache: false
    });

    const getPersonaSpy = vi.spyOn(PadronClient, 'getPersona').mockResolvedValue({
      cuit: '30710955057',
      businessName: 'Distribuidora Central S.R.L.',
      personType: 'JURIDICA',
      status: 'ACTIVO',
      fiscalCondition: 'IVA_RESPONSABLE_INSCRIPTO',
      fiscalConditionCode: 1,
      fiscalConditionName: 'IVA Responsable Inscripto',
      address: {
        street: 'Av. Libertador 4500',
        city: 'CABA',
        province: 'Ciudad Autónoma de Buenos Aires',
        postalCode: 'C1425'
      },
      queriedAt: new Date()
    });

    // Consulta con CUIT con guiones
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/taxpayers/30-71095505-7',
      headers: { 'x-api-key': tenantAKey }
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.cuit).toBe('30710955057');
    expect(body.businessName).toBe('Distribuidora Central S.R.L.');
    expect(body.fiscalCondition).toBe('IVA_RESPONSABLE_INSCRIPTO');
    expect(body.fiscalConditionCode).toBe(1);
    expect(body.address.street).toBe('Av. Libertador 4500');
    expect(getPersonaSpy).toHaveBeenCalledTimes(1);

    // 2. Caché: Segunda consulta al mismo CUIT responde sin volver a invocar el WS de padrón
    const resCache = await app.inject({
      method: 'GET',
      url: '/api/v1/taxpayers/30710955057',
      headers: { 'x-api-key': tenantAKey }
    });

    expect(resCache.statusCode).toBe(200);
    expect(resCache.json().businessName).toBe('Distribuidora Central S.R.L.');
    expect(getPersonaSpy).toHaveBeenCalledTimes(1); // Sigue en 1 gracias a la caché
  });

  it('3. GET /api/v1/taxpayers/:cuit - Rechaza CUIT inválido con error 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/taxpayers/20123456789', // CUIT con dígito verificador adulterado
      headers: { 'x-api-key': tenantAKey }
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('no es válido según el algoritmo oficial Módulo 11');
  });

  it('4. GET /api/v1/taxpayers/:cuit - Comercio B sin identidad fiscal no puede consultar', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/taxpayers/30710955057',
      headers: { 'x-api-key': tenantBKey }
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('El comercio debe contar con al menos una identidad fiscal');
  });
});
