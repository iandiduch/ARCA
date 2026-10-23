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
