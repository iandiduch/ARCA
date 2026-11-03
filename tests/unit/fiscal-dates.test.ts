import { describe, it, expect } from 'vitest';
import { isValidIsoDate, isoDateToAfip, isoDateToArgentinaNoon } from '../../src/core/fiscal/fiscal-dates.js';
import { redactWsaaCredentials } from '../../src/modules/arca/infrastructure/wsfev1/wsfev1-client.js';

describe('Fechas calendario para ARCA', () => {
  it('convierte YYYY-MM-DD a YYYYMMDD sin corrimiento de zona horaria', () => {
    expect(isoDateToAfip('2026-11-01')).toBe('20261101');
    expect(isoDateToAfip('2026-12-31')).toBe('20261231');
  });

  it('guarda la fecha al mediodía argentino para que se muestre el mismo día', () => {
    const d = isoDateToArgentinaNoon('2026-11-01');
    expect(d.toISOString()).toBe('2026-11-01T15:00:00.000Z');
    expect(d.toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })).toBe('1/11/2026');
  });

  it('rechaza fechas con formato o calendario inválido', () => {
    expect(isValidIsoDate('2026-02-31')).toBe(false);
    expect(isValidIsoDate('2026-11-1')).toBe(false);
    expect(isValidIsoDate('01/11/2026')).toBe(false);
    expect(isValidIsoDate('2024-02-29')).toBe(true);
    expect(() => isoDateToAfip('2026-13-01')).toThrow();
  });
});

describe('Redacción de credenciales WSAA', () => {
  it('oculta Token y Sign del XML SOAP', () => {
    const xml =
      '<fev:Auth><fev:Token>PD94bWwgdmVyc2lvbj0iMS4wIj8+abc+/=</fev:Token><fev:Sign>c2lnbmF0dXJl+/=</fev:Sign><fev:Cuit>20301234567</fev:Cuit></fev:Auth>';
    const redacted = redactWsaaCredentials(xml);
    expect(redacted).not.toContain('PD94bWwg');
    expect(redacted).not.toContain('c2lnbmF0dXJl');
    expect(redacted).toContain('<fev:Token>[REDACTED]</fev:Token>');
    expect(redacted).toContain('<fev:Sign>[REDACTED]</fev:Sign>');
    expect(redacted).toContain('<fev:Cuit>20301234567</fev:Cuit>');
  });
});
