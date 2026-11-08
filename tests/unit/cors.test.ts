import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { corsOptions, parseCorsOrigin } from '../../src/app/server.js';

describe('CORS Origin Wildcard Parser (parseCorsOrigin)', () => {
  it('debe mantener "*" sin modificaciones', () => {
    expect(parseCorsOrigin('*')).toBe('*');
  });

  it('debe devolver un string exacto si no contiene wildcards', () => {
    expect(parseCorsOrigin('https://pos.midominio.com')).toBe('https://pos.midominio.com');
  });

  it('debe convertir *.midominio.com en una RegExp que admita subdominios y el dominio principal', () => {
    const reg = parseCorsOrigin('*.midominio.com');
    expect(reg).toBeInstanceOf(RegExp);

    if (reg instanceof RegExp) {
      expect(reg.test('https://pos.midominio.com')).toBe(true);
      expect(reg.test('https://sucursal1.midominio.com')).toBe(true);
      expect(reg.test('https://mi-negocio.pos.midominio.com')).toBe(true);
      expect(reg.test('https://midominio.com')).toBe(true);
      expect(reg.test('http://pos.midominio.com')).toBe(true);
      expect(reg.test('https://midominio.com:3000')).toBe(true);

      // No debe admitir dominios no autorizados
      expect(reg.test('https://evil-midominio.com')).toBe(false);
      expect(reg.test('https://otrodominio.com')).toBe(false);
      expect(reg.test('https://midominio.com.malicious.com')).toBe(false);
    }
  });

  it('debe respetar el protocolo especificado si se pasa https://*.midominio.com', () => {
    const reg = parseCorsOrigin('https://*.midominio.com');
    expect(reg).toBeInstanceOf(RegExp);

    if (reg instanceof RegExp) {
      expect(reg.test('https://pos.midominio.com')).toBe(true);
      expect(reg.test('http://pos.midominio.com')).toBe(false);
    }
  });
});

describe('CORS_ORIGIN aplicado a las respuestas (corsOptions)', () => {
  async function preflight(corsOrigin: string, origin: string) {
    const app = Fastify();
    await app.register(cors, corsOptions(corsOrigin));
    app.post('/api/v1/invoices', async () => ({ ok: true }));
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/invoices',
      headers: { origin, 'access-control-request-method': 'POST' }
    });
    await app.close();
    return res.headers;
  }

  it('"none" no habilita ningún origen: un navegador no puede leer la API desde ningún sitio', async () => {
    const headers = await preflight('none', 'https://pos.midominio.com');
    expect(headers['access-control-allow-origin']).toBeUndefined();
    expect(headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('una lista de orígenes habilita sólo esos (con comodín de subdominio)', async () => {
    const list = 'https://pos.comercio1.com, https://*.midominio.com';
    expect((await preflight(list, 'https://pos.comercio1.com'))['access-control-allow-origin']).toBe('https://pos.comercio1.com');
    expect((await preflight(list, 'https://caja2.midominio.com'))['access-control-allow-origin']).toBe('https://caja2.midominio.com');
    expect((await preflight(list, 'https://sitio-malicioso.example'))['access-control-allow-origin']).toBeUndefined();
  });
});
