import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../../src/app/server.js';
import { closeDatabaseConnection } from '../../src/infrastructure/database/connection.js';
import { loadConfig } from '../../src/app/config.js';

describe('Catálogo Comercial de Clientes (Customer Routes & Isolation)', () => {
  let app: FastifyInstance;
  const config = loadConfig();

  let tenantAKey: string;
  let tenantBKey: string;
  let customerAId: string;

  beforeAll(async () => {
    app = await createApp({ enableLogging: false });
    await app.ready();

    // Crear dos tenants para verificar aislamiento
    const resA = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: { 'x-api-key': config.API_KEY_MASTER },
      payload: { name: 'Comercio A', slug: `cliente-test-a-${Date.now()}` }
    });
    const tenantA = resA.json();

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
      payload: { name: 'Comercio B', slug: `cliente-test-b-${Date.now()}` }
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

  it('1. Debe registrar un cliente consumidor final con DNI', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/customers',
      headers: { 'x-api-key': tenantAKey },
      payload: {
        name: 'Carlos Menéndez',
        documentType: 'DNI',
        documentNumber: '35123456',
        fiscalCondition: 'CONSUMIDOR_FINAL',
        email: 'carlos@example.com'
      }
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBeDefined();
    expect(body.documentTypeCode).toBe(96); // Código AFIP DNI
    expect(body.fiscalConditionCode).toBe(5); // Consumidor Final
    customerAId = body.id;
  });

  it('2. Debe registrar un cliente con CUIT válido (Responsable Inscripto)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/customers',
      headers: { 'x-api-key': tenantAKey },
      payload: {
        name: 'Servicios Generales S.A.',
        documentType: 'CUIT',
        documentNumber: '30-50361289-1',
        fiscalCondition: 'IVA_RESPONSABLE_INSCRIPTO',
        address: 'Av. Libertador 500, CABA'
      }
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.documentTypeCode).toBe(80); // Código AFIP CUIT
    expect(body.fiscalConditionCode).toBe(1); // Resp Inscripto
    expect(body.documentNumber).toBe('30503612891');
  });

  it('3. Debe rechazar cliente con CUIT inválido según Módulo 11', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/customers',
      headers: { 'x-api-key': tenantAKey },
      payload: {
        name: 'Empresa Falsa',
        documentType: 'CUIT',
        documentNumber: '30503612899', // Verificador erróneo
        fiscalCondition: 'IVA_RESPONSABLE_INSCRIPTO'
      }
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('VALIDATION_ERROR');
  });

  it('4. Debe rechazar duplicación de documento activo en el mismo comercio', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/customers',
      headers: { 'x-api-key': tenantAKey },
      payload: {
        name: 'Carlos Duplicado',
        documentType: 'DNI',
        documentNumber: '35123456'
      }
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('CONFLICT');
  });

  it('5. Búsqueda de clientes por texto (nombre o documento)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/customers?search=carlos',
      headers: { 'x-api-key': tenantAKey }
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.length).toBe(1);
    expect(body[0].name).toBe('Carlos Menéndez');
  });

  it('6. Actualizar cliente existente', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/customers/${customerAId}`,
      headers: { 'x-api-key': tenantAKey },
      payload: {
        phone: '+54 11 5555-9999',
        address: 'Calle Corrientes 1000'
      }
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().phone).toBe('+54 11 5555-9999');
  });

  it('7. AISLAMIENTO: Comercio B NO puede consultar ni modificar clientes del Comercio A', async () => {
    // Comercio B intenta ver el cliente de Comercio A
    const resGet = await app.inject({
      method: 'GET',
      url: `/api/v1/customers/${customerAId}`,
      headers: { 'x-api-key': tenantBKey }
    });

    expect(resGet.statusCode).toBe(404);

    // Comercio B intenta modificar el cliente de Comercio A
    const resPatch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/customers/${customerAId}`,
      headers: { 'x-api-key': tenantBKey },
      payload: { name: 'Hackeado' }
    });

    expect(resPatch.statusCode).toBe(404);
  });

  it('8. Archivar cliente (baja lógica)', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/customers/${customerAId}`,
      headers: { 'x-api-key': tenantAKey }
    });

    expect(res.statusCode).toBe(200);

    // No debe aparecer en listado activo
    const resList = await app.inject({
      method: 'GET',
      url: '/api/v1/customers?activeOnly=true',
      headers: { 'x-api-key': tenantAKey }
    });

    const activeIds = resList.json().map((c: any) => c.id);
    expect(activeIds).not.toContain(customerAId);
  });
});
