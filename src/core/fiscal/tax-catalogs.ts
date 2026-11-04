import { ValidationError } from '../errors/app-error.js';

/**
 * Catálogos impositivos oficiales ARCA / AFIP (WSFEv1).
 */

export interface IvaRateDefinition {
  rate: number;
  afipCode: number;
  description: string;
}

export const IVA_RATES: Record<string, IvaRateDefinition> = {
  IVA_21: { rate: 21.0, afipCode: 5, description: '21%' },
  IVA_10_5: { rate: 10.5, afipCode: 4, description: '10.5%' },
  IVA_0: { rate: 0.0, afipCode: 3, description: '0%' },
  IVA_27: { rate: 27.0, afipCode: 6, description: '27%' },
  IVA_5: { rate: 5.0, afipCode: 8, description: '5%' },
  IVA_2_5: { rate: 2.5, afipCode: 9, description: '2.5%' },
  NO_GRAVADO: { rate: 0.0, afipCode: 1, description: 'No Gravado' },
  EXENTO: { rate: 0.0, afipCode: 2, description: 'Exento' }
};

export function resolveIvaCode(rate: number): { afipCode: number; rate: number } {
  const rounded = Number(rate.toFixed(2));
  if (rounded === 21.0) return { afipCode: 5, rate: 21.0 };
  if (rounded === 10.5) return { afipCode: 4, rate: 10.5 };
  if (rounded === 0.0) return { afipCode: 3, rate: 0.0 };
  if (rounded === 27.0) return { afipCode: 6, rate: 27.0 };
  if (rounded === 5.0) return { afipCode: 8, rate: 5.0 };
  if (rounded === 2.5) return { afipCode: 9, rate: 2.5 };
  return { afipCode: 5, rate: 21.0 }; // Default 21%
}

/** Alícuota correspondiente a cada código de IVA de WSFEv1 (1=No Gravado, 2=Exento, 3=0%) */
export const IVA_CODE_RATES: Record<number, number> = {
  1: 0,
  2: 0,
  3: 0,
  4: 10.5,
  5: 21,
  6: 27,
  8: 5,
  9: 2.5
};

const RATE_TO_CODE: Record<string, number> = { '0': 3, '2.5': 9, '5': 8, '10.5': 4, '21': 5, '27': 6 };

/**
 * Resuelve alícuota y código de IVA de un ítem. Si no se informa ninguno se asume 21%.
 * Rechaza alícuotas fuera del catálogo de ARCA y combinaciones incoherentes (p. ej. Exento con 21%).
 */
export function resolveItemVat(vatRate?: number, vatAfipCode?: number): { rate: number; afipCode: number } {
  if (vatAfipCode !== undefined) {
    const codeRate = IVA_CODE_RATES[vatAfipCode];
    if (codeRate === undefined) {
      throw new ValidationError(
        `Código de IVA ${vatAfipCode} inválido. Valores admitidos: ${Object.keys(IVA_CODE_RATES).join(', ')}`
      );
    }
    if (vatRate !== undefined && Number(vatRate.toFixed(2)) !== codeRate) {
      throw new ValidationError(
        `La alícuota ${vatRate}% no corresponde al código de IVA ${vatAfipCode} (${codeRate}%)`
      );
    }
    return { rate: codeRate, afipCode: vatAfipCode };
  }

  const rate = vatRate ?? 21;
  const afipCode = RATE_TO_CODE[String(Number(rate.toFixed(2)))];
  if (afipCode === undefined) {
    throw new ValidationError(`Alícuota de IVA ${rate}% inválida. Valores admitidos: 0, 2.5, 5, 10.5, 21, 27`);
  }
  return { rate, afipCode };
}

/** Tipos de comprobante soportados por la emisión en WSFEv1 */
export const SUPPORTED_VOUCHER_TYPES = [1, 2, 3, 6, 7, 8, 11, 12, 13, 51, 52, 53];

export const CONCEPT_TYPES = {
  PRODUCTOS: 1,
  SERVICIOS: 2,
  PRODUCTOS_Y_SERVICIOS: 3
} as const;

export const UNIT_MEASURES: Record<string, { code: number; name: string }> = {
  UNIDAD: { code: 7, name: 'Unidad' },
  KILOGRAMO: { code: 1, name: 'Kilogramo' },
  METRO: { code: 2, name: 'Metro' },
  LITRO: { code: 3, name: 'Litro' },
  OTRO: { code: 98, name: 'Otras unidades' }
};

export const VOUCHER_TYPES = {
  FACTURA_A: 1,
  NOTA_DE_DEBITO_A: 2,
  NOTA_DE_CREDITO_A: 3,
  FACTURA_B: 6,
  NOTA_DE_DEBITO_B: 7,
  NOTA_DE_CREDITO_B: 8,
  FACTURA_C: 11,
  NOTA_DE_DEBITO_C: 12,
  NOTA_DE_CREDITO_C: 13,
  FACTURA_M: 51,
  NOTA_DE_DEBITO_M: 52,
  NOTA_DE_CREDITO_M: 53
} as const;

export const DOC_TYPES = {
  CUIT: 80,
  CUIL: 86,
  CDI: 87,
  DNI: 96,
  CONSUMIDOR_FINAL: 99
} as const;

export function getVoucherLetter(voucherType: number): 'A' | 'B' | 'C' | 'M' {
  switch (voucherType) {
    case 1:
    case 2:
    case 3:
      return 'A';
    case 6:
    case 7:
    case 8:
      return 'B';
    case 11:
    case 12:
    case 13:
      return 'C';
    case 51:
    case 52:
    case 53:
      return 'M';
    default:
      return 'B';
  }
}

export function isCreditNote(voucherType: number): boolean {
  return [3, 8, 13, 53].includes(voucherType);
}

export function isDebitNote(voucherType: number): boolean {
  return [2, 7, 12, 52].includes(voucherType);
}

export function isInvoice(voucherType: number): boolean {
  return [1, 6, 11, 51].includes(voucherType);
}

export function requiresVatBreakdown(voucherType: number): boolean {
  const letter = getVoucherLetter(voucherType);
  return letter !== 'C'; // Monotributo (C) no discrimina IVA en WSFEv1
}
