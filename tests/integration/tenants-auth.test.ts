import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../../src/app/server.js';
import { closeDatabaseConnection } from '../../src/infrastructure/database/connection.js';
import { loadConfig } from '../../src/app/config.js';

describe('Seguridad y Aislamiento Multi-Tenant (Fase 2)', () => {
  let app: FastifyInstance;
  const config = loadConfig();
  const masterKey = config.API_KEY_MASTER;

  let tenantA: { id: string; name: string; slug: string };
  let tenantB: { id: string; name: string; slug: string };
  let apiKeyA: { id: string; rawKey: string };
  let apiKeyB: { id: string; rawKey: string };

  beforeAll(async () => {
    app = await createApp({ enableLogging: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await closeDatabaseConnection();
  });

  it('1. Debe rechazar peticiones sin credenciales con 401 Unauthorized', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/tenants'
    });

    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.error).toBe('UNAUTHORIZED');
  });

  it('2. Debe rechazar claves falsas o malformadas con 401 Unauthorized', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/tenants',
      headers: { 'x-api-key': 'arca_live_invalida_0123456789abcdef' }
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('UNAUTHORIZED');
  });

  it('3. La clave maestra (Master Key) debe poder crear comercios (Tenants)', async () => {
    const slugA = `onion-pos-${Date.now()}`;
    const resA = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: { 'x-api-key': masterKey },
      payload: {
        name: 'Onion POS Kiosco Central',
        slug: slugA
      }
    });

    expect(resA.statusCode).toBe(201);
    tenantA = resA.json();
    expect(tenantA.id).toBeDefined();
    expect(tenantA.slug).toBe(slugA);

    const slugB = `tienda-b-${Date.now()}`;
    const resB = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: { 'x-api-key': masterKey },
      payload: {
        name: 'Tienda B Sucursal 1',
        slug: slugB
      }
    });

    expect(resB.statusCode).toBe(201);
    tenantB = resB.json();
  });

  it('4. Debe rechazar la creación de comercios con slug duplicado con 409 Conflict', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: { 'x-api-key': masterKey },
      payload: {
        name: 'Duplicado',
        slug: tenantA.slug
      }
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('CONFLICT');
  });

  it('5. Debe permitir generar API Keys para un comercio', async () => {
    const resA = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${tenantA.id}/api-keys`,
      headers: { 'x-api-key': masterKey },
      payload: {
        name: 'Onion POS Terminal 1',
        role: 'pos_client'
      }
    });

    expect(resA.statusCode).toBe(201);
    const bodyA = resA.json();
    expect(bodyA.rawKey).toMatch(/^arca_live_/);
    expect(bodyA.tenantId).toBe(tenantA.id);
    apiKeyA = { id: bodyA.id, rawKey: bodyA.rawKey };

    const resB = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${tenantB.id}/api-keys`,
      headers: { 'x-api-key': masterKey },
      payload: {
        name: 'Tienda B Terminal 1'
      }
    });

    expect(resB.statusCode).toBe(201);
    const bodyB = resB.json();
    apiKeyB = { id: bodyB.id, rawKey: bodyB.rawKey };
  });

  it('6. El comercio A autenticado con su API Key solo ve sus propios datos (/me)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/tenants/me',
      headers: { 'x-api-key': apiKeyA.rawKey }
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe(tenantA.id);
    expect(body.slug).toBe(tenantA.slug);
  });

  it('7. Un comercio no puede realizar acciones reservadas a la clave maestra', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: { 'x-api-key': apiKeyA.rawKey },
      payload: {
        name: 'Intento de crear comercio como tenant',
        slug: 'intento-invalido'
      }
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('FORBIDDEN');
  });

  it('8. AISLAMIENTO ESTRICTO: El comercio A NO puede ver ni crear claves del comercio B', async () => {
    // Intento de listar claves de otro comercio
    const resList = await app.inject({
      method: 'GET',
      url: `/api/v1/tenants/${tenantB.id}/api-keys`,
      headers: { 'x-api-key': apiKeyA.rawKey }
    });

    expect(resList.statusCode).toBe(403);
    expect(resList.json().message).toContain('Violación de aislamiento');

    // Intento de crear una clave en otro comercio
    const resCreate = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${tenantB.id}/api-keys`,
      headers: { 'x-api-key': apiKeyA.rawKey },
      payload: { name: 'Clave Infiltrada' }
    });

    expect(resCreate.statusCode).toBe(403);
    expect(resCreate.json().message).toContain('Violación de aislamiento');
  });

  it('9. Revocación de API Keys: una clave revocada deja de funcionar inmediatamente', async () => {
    // Crear una segunda clave para Tenant A
    const resCreate = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${tenantA.id}/api-keys`,
      headers: { 'x-api-key': apiKeyA.rawKey },
      payload: { name: 'Clave Temporal para Revocar' }
    });
    expect(resCreate.statusCode).toBe(201);
    const tempKey = resCreate.json();

    // Comprobar que funciona antes de revocar
    const resCheckBefore = await app.inject({
      method: 'GET',
      url: '/api/v1/tenants/me',
      headers: { 'x-api-key': tempKey.rawKey }
    });
    expect(resCheckBefore.statusCode).toBe(200);

    // Revocarla
    const resRevoke = await app.inject({
      method: 'DELETE',
      url: `/api/v1/tenants/${tenantA.id}/api-keys/${tempKey.id}`,
      headers: { 'x-api-key': apiKeyA.rawKey }
    });
    expect(resRevoke.statusCode).toBe(200);

    // Comprobar que ahora es rechazada
    const resCheckAfter = await app.inject({
      method: 'GET',
      url: '/api/v1/tenants/me',
      headers: { 'x-api-key': tempKey.rawKey }
    });
    expect(resCheckAfter.statusCode).toBe(401);
  });

  it('10. Pista de Auditoría: El comercio A consulta sus logs y no ve los del comercio B', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/audit-logs',
      headers: { 'x-api-key': apiKeyA.rawKey }
    });

    expect(res.statusCode).toBe(200);
    const logs = res.json();
    expect(Array.isArray(logs)).toBe(true);
    expect(logs.length).toBeGreaterThan(0);

    // Verificar que TODOS los registros pertenecen únicamente a Tenant A
    for (const log of logs) {
      expect(log.tenantId).toBe(tenantA.id);
    }
  });
});
