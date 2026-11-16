import { describe, it, expect } from 'vitest';
import {
  parseIssuerTaxCondition,
  normalizeIssuerTaxCondition,
  normalizeGrossIncomeNumber,
  normalizeActivityStartDate
} from '../../src/core/fiscal/tax-condition.js';
import { ValidationError } from '../../src/core/errors/app-error.js';

describe('Condición frente al IVA del emisor (tax-condition.ts)', () => {
  it('parsea los valores canónicos del padrón de ARCA', () => {
    expect(parseIssuerTaxCondition('IVA_RESPONSABLE_INSCRIPTO')).toBe('IVA_RESPONSABLE_INSCRIPTO');
    expect(parseIssuerTaxCondition('RESPONSABLE_MONOTRIBUTO')).toBe('RESPONSABLE_MONOTRIBUTO');
    expect(parseIssuerTaxCondition('IVA_EXENTO')).toBe('IVA_EXENTO');
  });

  it('acepta los alias del POS sin distinguir mayúsculas ni espacios', () => {
    expect(parseIssuerTaxCondition('responsable_inscripto')).toBe('IVA_RESPONSABLE_INSCRIPTO');
    expect(parseIssuerTaxCondition('iva_responsable_inscripto')).toBe('IVA_RESPONSABLE_INSCRIPTO');
    expect(parseIssuerTaxCondition('Responsable_Inscripto')).toBe('IVA_RESPONSABLE_INSCRIPTO');
    expect(parseIssuerTaxCondition('monotributo')).toBe('RESPONSABLE_MONOTRIBUTO');
    expect(parseIssuerTaxCondition('responsable_monotributo')).toBe('RESPONSABLE_MONOTRIBUTO');
    expect(parseIssuerTaxCondition('MONOTRIBUTO')).toBe('RESPONSABLE_MONOTRIBUTO');
    expect(parseIssuerTaxCondition('exento')).toBe('IVA_EXENTO');
    expect(parseIssuerTaxCondition('iva_exento')).toBe('IVA_EXENTO');
    expect(parseIssuerTaxCondition('  EXENTO  ')).toBe('IVA_EXENTO');
  });

  it('devuelve null para valores ausentes o desconocidos', () => {
    expect(parseIssuerTaxCondition(null)).toBeNull();
    expect(parseIssuerTaxCondition(undefined)).toBeNull();
    expect(parseIssuerTaxCondition('')).toBeNull();
    expect(parseIssuerTaxCondition('cualquiera')).toBeNull();
    expect(parseIssuerTaxCondition('IVA_RESPONSABLE_NO_INSCRIPTO')).toBeNull();
  });

  it('normaliza al valor canónico y rechaza los inválidos', () => {
    expect(normalizeIssuerTaxCondition('monotributo')).toBe('RESPONSABLE_MONOTRIBUTO');
    expect(normalizeIssuerTaxCondition('iva_responsable_inscripto')).toBe('IVA_RESPONSABLE_INSCRIPTO');
    expect(normalizeIssuerTaxCondition('EXENTO')).toBe('IVA_EXENTO');
    expect(() => normalizeIssuerTaxCondition('cualquiera')).toThrow(ValidationError);
    expect(() => normalizeIssuerTaxCondition('RI')).toThrow(ValidationError);
  });
});

describe('Número de Ingresos Brutos', () => {
  it('acepta dígitos, guiones, puntos y barras', () => {
    expect(normalizeGrossIncomeNumber('901-234567-8')).toBe('901-234567-8');
    expect(normalizeGrossIncomeNumber('901234567')).toBe('901234567');
    expect(normalizeGrossIncomeNumber('901.234.567/8')).toBe('901.234.567/8');
    expect(normalizeGrossIncomeNumber(' 901-234567-8 ')).toBe('901-234567-8');
  });

  it('normaliza "Exento" sin distinguir mayúsculas', () => {
    expect(normalizeGrossIncomeNumber('Exento')).toBe('Exento');
    expect(normalizeGrossIncomeNumber('EXENTO')).toBe('Exento');
    expect(normalizeGrossIncomeNumber(' exento ')).toBe('Exento');
  });

  it('rechaza vacío, letras, demasiado corto o demasiado largo', () => {
    expect(() => normalizeGrossIncomeNumber('')).toThrow(ValidationError);
    expect(() => normalizeGrossIncomeNumber('12')).toThrow(ValidationError);
    expect(() => normalizeGrossIncomeNumber('abc-123')).toThrow(ValidationError);
    expect(() => normalizeGrossIncomeNumber('/901234567')).toThrow(ValidationError);
    expect(() => normalizeGrossIncomeNumber('9'.repeat(31))).toThrow(ValidationError);
  });
});

describe('Inicio de actividades', () => {
  const now = new Date('2026-11-16T12:00:00Z');

  it('acepta una fecha real en formato AAAA-MM-DD, incluido el 29 de febrero bisiesto', () => {
    expect(normalizeActivityStartDate('2020-01-01', now)).toBe('2020-01-01');
    expect(normalizeActivityStartDate(' 2024-02-29 ', now)).toBe('2024-02-29');
    expect(normalizeActivityStartDate('2026-11-16', now)).toBe('2026-11-16');
  });

  it('rechaza un formato distinto de AAAA-MM-DD', () => {
    expect(() => normalizeActivityStartDate('01/01/2020', now)).toThrow(ValidationError);
    expect(() => normalizeActivityStartDate('2020-1-1', now)).toThrow(ValidationError);
    expect(() => normalizeActivityStartDate('2020-01-01T00:00:00Z', now)).toThrow(ValidationError);
  });

  it('rechaza fechas inexistentes en el calendario', () => {
    expect(() => normalizeActivityStartDate('2023-02-30', now)).toThrow(ValidationError);
    expect(() => normalizeActivityStartDate('2023-13-01', now)).toThrow(ValidationError);
    expect(() => normalizeActivityStartDate('2023-02-29', now)).toThrow(ValidationError);
  });

  it('rechaza una fecha futura o anterior a 1900', () => {
    expect(() => normalizeActivityStartDate('2026-11-17', now)).toThrow(ValidationError);
    expect(() => normalizeActivityStartDate('1899-12-31', now)).toThrow(ValidationError);
  });
});
