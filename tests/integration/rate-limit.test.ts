import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, parseTrustProxy } from '../../src/app/server.js';
import { closeDatabaseConnection } from '../../src/infrastructure/database/connection.js';
import { loadConfig } from '../../src/app/config.js';
import { clearKnownKeys, rateLimitKey, rememberAuthenticatedKey } from '../../src/core/security/rate-limit-key.js';

describe('Rate limit y proxy inverso', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    clearKnownKeys();
    app = await createApp({ enableLogging: false, rateLimitMax: 3 });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await closeDatabaseConnection();
  });

  it('parsea TRUST_PROXY', () => {
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('10.0.0.0/8')).toBe('10.0.0.0/8');
  });

  it('las claves desconocidas comparten el bucket de su IP; las autenticadas tienen el propio', async () => {
    expect(await rateLimitKey({ 'x-api-key': 'falsa-1' }, '1.2.3.4')).toBe('ip:1.2.3.4');
    expect(await rateLimitKey({ 'x-api-key': 'falsa-2' }, '1.2.3.4')).toBe('ip:1.2.3.4');

    rememberAuthenticatedKey('arca_live_valida');
    expect(await rateLimitKey({ authorization: 'Bearer arca_live_valida' }, '1.2.3.4')).toMatch(/^key:/);
  });

  it('rotar claves falsas no evade el límite', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/tenants/me',
        headers: { 'x-api-key': `arca_live_falsa_${i}` }
      });
      statuses.push(res.statusCode);
    }
    expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
    expect(statuses.slice(3)).toEqual([429, 429]);
  });

  it('una clave válida no queda bloqueada por el abuso desde su misma IP', async () => {
    const masterKey = loadConfig().API_KEY_MASTER;
    const res = await app.inject({ method: 'GET', url: '/api/v1/tenants', headers: { 'x-api-key': masterKey } });
    expect(res.statusCode).toBe(200);
  });
});
