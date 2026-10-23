import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../../src/app/server.js';
import { closeDatabaseConnection } from '../../src/infrastructure/database/connection.js';
import { loadConfig } from '../../src/app/config.js';

describe('Catálogo Comercial de Productos (Product Routes & CSV)', () => {
  let app: FastifyInstance;
  const config = loadConfig();

  let tenantAKey: string;
  let tenantBKey: string;
  let productAId: string;

  beforeAll(async () => {
    app = await createApp({ enableLogging: false });
    await app.ready();

    // Crear dos tenants para verificar aislamiento
    const resA = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: { 'x-api-key': config.API_KEY_MASTER },
      payload: { name: 'Comercio Prod A', slug: `prod-test-a-${Date.now()}` }
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
      payload: { name: 'Comercio Prod B', slug: `prod-test-b-${Date.now()}` }
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

  it('1. Debe registrar un producto con IVA 21%', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/products',
      headers: { 'x-api-key': tenantAKey },
      payload: {
        name: 'Coca Cola 500ml',
        internalCode: 'BEB-001',
        barcode: '7791234567890',
        costPrice: 800.5,
        salePrice: 1500.0,
        ivaRate: 21.0,
        unitMeasure: 'UNIDAD'
      }
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBeDefined();
    expect(body.ivaCode).toBe(5); // AFIP 21%
    expect(body.unitMeasureCode).toBe(7); // AFIP Unidades
    expect(body.salePrice).toBe('1500.00');
    productAId = body.id;
  });

  it('2. Debe registrar un producto con IVA reducido 10.5%', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/products',
      headers: { 'x-api-key': tenantAKey },
      payload: {
        name: 'Pan Francés por KG',
        internalCode: 'PAN-001',
        costPrice: 900.0,
        salePrice: 1800.0,
        ivaRate: 10.5,
        unitMeasure: 'KILOGRAMO'
      }
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.ivaCode).toBe(4); // AFIP 10.5%
    expect(body.unitMeasureCode).toBe(1); // AFIP Kg
  });

  it('3. Debe rechazar precio de venta negativo con 400 Validation Error', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/products',
      headers: { 'x-api-key': tenantAKey },
      payload: {
        name: 'Producto Precio Inválido',
        salePrice: -50.0
      }
    });

    expect(res.statusCode).toBe(400);
  });

  it('4. Debe rechazar código interno duplicado en el mismo comercio', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/products',
      headers: { 'x-api-key': tenantAKey },
      payload: {
        name: 'Coca Cola Duplicada',
        internalCode: 'BEB-001',
        salePrice: 1600.0
      }
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('CONFLICT');
  });

  it('5. Búsqueda por lector de código de barras exacto', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/products?barcode=7791234567890',
      headers: { 'x-api-key': tenantAKey }
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.length).toBe(1);
    expect(body[0].name).toBe('Coca Cola 500ml');
  });

  it('6. Importación masiva desde CSV', async () => {
    const csvData = [
      'codigo_interno,codigo_barras,nombre,descripcion,precio_costo,precio_venta,alicuota_iva,unidad_medida',
      'ALF-001,7790001,Alfajor Triple,Alfajor de chocolate,300.00,700.00,21.0,UNIDAD',
      'AGU-001,7790002,Agua Mineral 500ml,Agua sin gas,200.00,500.00,21.0,UNIDAD'
    ].join('\n');

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/products/import-csv',
      headers: { 'x-api-key': tenantAKey },
      payload: { csvContent: csvData }
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalProcessed).toBe(2);
    expect(body.created).toBe(2);
    expect(body.errors.length).toBe(0);
  });

  it('7. Exportación del catálogo completo a CSV', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/products/export-csv',
      headers: { 'x-api-key': tenantAKey }
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const csvContent = res.body;
    expect(csvContent).toContain('codigo_interno,codigo_barras,nombre');
    expect(csvContent).toContain('Coca Cola 500ml');
    expect(csvContent).toContain('Alfajor Triple');
  });

  it('8. AISLAMIENTO: Comercio B NO puede acceder ni ver los productos del Comercio A', async () => {
    // Comercio B intenta ver producto del Comercio A
    const resGet = await app.inject({
      method: 'GET',
      url: `/api/v1/products/${productAId}`,
      headers: { 'x-api-key': tenantBKey }
    });

    expect(resGet.statusCode).toBe(404);

    // Listado de Comercio B debe estar vacío
    const resList = await app.inject({
      method: 'GET',
      url: '/api/v1/products',
      headers: { 'x-api-key': tenantBKey }
    });

    expect(resList.statusCode).toBe(200);
    expect(resList.json().length).toBe(0);
  });

  it('9. Archivar producto (baja lógica)', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/products/${productAId}`,
      headers: { 'x-api-key': tenantAKey }
    });

    expect(res.statusCode).toBe(200);

    // No debe aparecer en listado activo
    const resList = await app.inject({
      method: 'GET',
      url: '/api/v1/products?activeOnly=true',
      headers: { 'x-api-key': tenantAKey }
    });

    const activeIds = resList.json().map((p: any) => p.id);
    expect(activeIds).not.toContain(productAId);
  });
});
