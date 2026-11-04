/**
 * Utilidades de fechas calendario para comprobantes ARCA.
 *
 * Las fechas de servicio y vencimiento llegan como "YYYY-MM-DD" (fecha calendario argentina, sin hora).
 * `new Date('YYYY-MM-DD')` las interpreta como medianoche UTC, que en Buenos Aires (UTC-3) es el día anterior.
 */

const ISO_DATE_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidIsoDate(value: string): boolean {
  const match = ISO_DATE_REGEX.exec(value);
  if (!match) return false;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/**
 * Convierte "YYYY-MM-DD" al formato de WSFEv1 "YYYYMMDD" sin pasar por zonas horarias.
 */
export function isoDateToAfip(value: string): string {
  if (!isValidIsoDate(value)) {
    throw new Error(`Fecha inválida "${value}": se espera formato YYYY-MM-DD`);
  }
  return value.replace(/-/g, '');
}

/**
 * Convierte "YYYY-MM-DD" a un Date al mediodía de Buenos Aires, de modo que al formatearlo
 * en la zona horaria argentina (PDF, reportes) siempre resulte el mismo día calendario.
 */
export function isoDateToArgentinaNoon(value: string): Date {
  if (!isValidIsoDate(value)) {
    throw new Error(`Fecha inválida "${value}": se espera formato YYYY-MM-DD`);
  }
  return new Date(`${value}T12:00:00-03:00`);
}

/** Inicio del día calendario argentino (00:00:00.000 en Buenos Aires) */
export function argentinaStartOfDay(value: string): Date {
  if (!isValidIsoDate(value)) {
    throw new Error(`Fecha inválida "${value}": se espera formato YYYY-MM-DD`);
  }
  return new Date(`${value}T00:00:00.000-03:00`);
}

/** Fin del día calendario argentino (23:59:59.999 en Buenos Aires), para filtros "hasta" inclusivos */
export function argentinaEndOfDay(value: string): Date {
  if (!isValidIsoDate(value)) {
    throw new Error(`Fecha inválida "${value}": se espera formato YYYY-MM-DD`);
  }
  return new Date(`${value}T23:59:59.999-03:00`);
}
