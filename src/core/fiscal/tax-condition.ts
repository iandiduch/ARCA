import { ValidationError } from '../errors/app-error.js';

/** Condición frente al IVA del emisor (identidad fiscal), en el vocabulario del padrón de ARCA. */
export const ISSUER_TAX_CONDITIONS = ['IVA_RESPONSABLE_INSCRIPTO', 'RESPONSABLE_MONOTRIBUTO', 'IVA_EXENTO'] as const;
export type IssuerTaxCondition = (typeof ISSUER_TAX_CONDITIONS)[number];

// Alias aceptados (sin distinguir mayúsculas): el POS manda 'monotributo' / 'responsable_inscripto' / 'exento'
const ALIASES: Record<string, IssuerTaxCondition> = {
  iva_responsable_inscripto: 'IVA_RESPONSABLE_INSCRIPTO',
  responsable_inscripto: 'IVA_RESPONSABLE_INSCRIPTO',
  responsable_monotributo: 'RESPONSABLE_MONOTRIBUTO',
  monotributo: 'RESPONSABLE_MONOTRIBUTO',
  iva_exento: 'IVA_EXENTO',
  exento: 'IVA_EXENTO'
};

export const ISSUER_TAX_CONDITION_LABELS: Record<IssuerTaxCondition, string> = {
  IVA_RESPONSABLE_INSCRIPTO: 'IVA Responsable Inscripto',
  RESPONSABLE_MONOTRIBUTO: 'Responsable Monotributo',
  IVA_EXENTO: 'IVA Sujeto Exento'
};

/** Devuelve el valor canónico o null si no es una condición de emisor reconocida. */
export function parseIssuerTaxCondition(value: string | null | undefined): IssuerTaxCondition | null {
  if (!value) return null;
  return ALIASES[value.trim().toLowerCase()] ?? null;
}

export function normalizeIssuerTaxCondition(value: string): IssuerTaxCondition {
  const parsed = parseIssuerTaxCondition(value);
  if (!parsed) {
    throw new ValidationError(
      `Condición frente al IVA "${value}" inválida. Valores admitidos: ${ISSUER_TAX_CONDITIONS.join(', ')}`
    );
  }
  return parsed;
}

/** Ingresos Brutos: número (dígitos, guiones, barras o puntos) o "Exento". Devuelve el valor limpio. */
export function normalizeGrossIncomeNumber(value: string): string {
  const v = value.trim();
  if (/^exento$/i.test(v)) return 'Exento';
  if (!/^[0-9][0-9./-]{2,29}$/.test(v)) {
    throw new ValidationError(
      `Número de Ingresos Brutos "${value}" inválido: debe ser el número de inscripción (dígitos y guiones) o "Exento"`
    );
  }
  return v;
}

/** Inicio de actividades: fecha real YYYY-MM-DD, no futura. */
export function normalizeActivityStartDate(value: string, now = new Date()): string {
  const v = value.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  const d = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
  if (!m || !d || d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) {
    throw new ValidationError(`Fecha de inicio de actividades "${value}" inválida: use el formato AAAA-MM-DD`);
  }
  if (Number(m[1]) < 1900) {
    throw new ValidationError(`La fecha de inicio de actividades "${value}" no puede ser anterior a 1900`);
  }
  // "Hoy" en Argentina (UTC-3, sin horario de verano)
  const todayAr = new Date(now.getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10);
  if (v > todayAr) {
    throw new ValidationError(`La fecha de inicio de actividades "${value}" no puede ser futura`);
  }
  return v;
}
