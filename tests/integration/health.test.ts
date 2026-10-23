import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../../src/app/server.js';
import { closeDatabaseConnection } from '../../src/infrastructure/database/connection.js';

describe('Endpoints de Diagnóstico y Salud (Health Routes)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createApp({ enableLogging: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await closeDatabaseConnection();
  });

  it('GET /health/live debe responder 200 OK con status alive', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health/live'
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('alive');
    expect(body.timestamp).toBeDefined();
    expect(body.uptimeSeconds).toBeTypeOf('number');
  });

  it('GET / debe responder con metadatos del servicio y enlaces a documentación', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/'
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.name).toBe('ARCA Fiscal API');
    expect(body.version).toBe('0.1.0');
    expect(body.documentation).toBe('/documentation');
    expect(body.health).toEqual({
      liveness: '/health/live',
      readiness: '/health/ready'
    });
  });

  it('GET a ruta inexistente debe retornar 404 estructurado', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/ruta-que-no-existe'
    });

    expect(response.statusCode).toBe(404);
  });
});
