import { describe, it, expect } from 'vitest';
import { parseCorsOrigin } from '../../src/app/server.js';

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
