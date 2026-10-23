import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../../src/app/server.js';
import { closeDatabaseConnection } from '../../src/infrastructure/database/connection.js';

describe('Documentación OpenAPI / Swagger (/documentation)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createApp({ enableLogging: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await closeDatabaseConnection();
  });

  it('GET /documentation/json debe retornar la especificación OpenAPI 3.0 válida', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/documentation/json'
    });

    expect(response.statusCode).toBe(200);
    const spec = response.json();
    expect(spec.openapi).toMatch(/^3\./);
    expect(spec.info.title).toContain('ARCA');
    expect(spec.paths).toBeDefined();
    expect(spec.paths['/health/live']).toBeDefined();
    expect(spec.paths['/health/ready']).toBeDefined();
  });
});
