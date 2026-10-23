/**
 * Validador oficial de CUIT/CUIL argentino mediante el algoritmo Módulo 11.
 * Referencia: AFIP / ARCA RG 1415 y normativa aplicable.
 */

export function cleanDocumentNumber(doc: string): string {
  return doc.replace(/\D/g, '');
}

export function isValidCuit(cuit: string): boolean {
  const clean = cleanDocumentNumber(cuit);

  if (clean.length !== 11) {
    return false;
  }

  // Tipos válidos iniciales: 20, 23, 24, 27 (físicas), 30, 33, 34 (jurídicas)
  const validPrefixes = ['20', '23', '24', '27', '30', '33', '34'];
  const prefix = clean.substring(0, 2);
  if (!validPrefixes.includes(prefix)) {
    return false;
  }

  const multipliers = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  let sum = 0;

  for (let i = 0; i < 10; i++) {
    sum += Number(clean[i]) * multipliers[i]!;
  }

  const remainder = sum % 11;
  let expectedVerifier = 11 - remainder;

  if (expectedVerifier === 11) {
    expectedVerifier = 0;
  } else if (expectedVerifier === 10) {
    expectedVerifier = 9;
  }

  const actualVerifier = Number(clean[10]);
  return expectedVerifier === actualVerifier;
}

export function isValidDni(dni: string): boolean {
  const clean = cleanDocumentNumber(dni);
  return clean.length >= 6 && clean.length <= 8;
}

export function formatCuit(cuit: string): string {
  const clean = cleanDocumentNumber(cuit);
  if (clean.length !== 11) return cuit;
  return `${clean.slice(0, 2)}-${clean.slice(2, 10)}-${clean.slice(10)}`;
}

export interface DocumentTypeMapping {
  name: string;
  afipCode: number;
}

export const DOCUMENT_TYPES: Record<string, DocumentTypeMapping> = {
  CUIT: { name: 'CUIT', afipCode: 80 },
  CUIL: { name: 'CUIL', afipCode: 86 },
  CDI: { name: 'CDI', afipCode: 87 },
  DNI: { name: 'DNI', afipCode: 96 },
  PASAPORTE: { name: 'Pasaporte', afipCode: 94 },
  CI_EXTRANJERA: { name: 'C.I. Extranjera', afipCode: 91 },
  OTRO: { name: 'Sin Identificar / Consumidor Final', afipCode: 99 }
};

export interface FiscalConditionMapping {
  name: string;
  afipCode: number;
}

export const FISCAL_CONDITIONS: Record<string, FiscalConditionMapping> = {
  IVA_RESPONSABLE_INSCRIPTO: { name: 'IVA Responsable Inscripto', afipCode: 1 },
  CONSUMIDOR_FINAL: { name: 'Consumidor Final', afipCode: 5 },
  RESPONSABLE_MONOTRIBUTO: { name: 'Responsable Monotributo', afipCode: 6 },
  IVA_EXENTO: { name: 'IVA Exento', afipCode: 4 },
  NO_RESPONSABLE: { name: 'No Responsable', afipCode: 3 }
};
