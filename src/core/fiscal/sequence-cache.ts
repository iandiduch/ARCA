/**
 * Dueño de una secuencia fiscal en ARCA: la numeración es única por entorno + CUIT + ptoVta + tipo, sin importar
 * cuántas identidades fiscales (de uno o varios comercios) se hayan dado de alta con el mismo CUIT (N4).
 */
export function sequenceOwner(identity: { cuit: string; environment: string }): string {
  return `${identity.environment}:${identity.cuit.replace(/\D/g, '')}`;
}

/**
 * Caché en memoria del último número de comprobante autorizado por secuencia fiscal (entorno + CUIT + ptoVta + tipo).
 * Reduce a la mitad las llamadas a ARCA eliminando FECompUltimoAutorizado en el flujo habitual de emisión.
 * Se invalida automáticamente ante errores de numeración (código 10016), inconsistencias locales o reconciliaciones.
 */
export class SequenceNumberCache {
  private static cache = new Map<string, number>();

  /** @param owner resultado de sequenceOwner(identity) */
  public static buildKey(owner: string, pointOfSaleNumber: number, voucherType: number): string {
    return `${owner}:${pointOfSaleNumber}:${voucherType}`;
  }

  public static get(key: string): number | undefined {
    return this.cache.get(key);
  }

  public static set(key: string, lastAuthorizedNumber: number): void {
    this.cache.set(key, lastAuthorizedNumber);
  }

  public static invalidate(key: string): void {
    this.cache.delete(key);
  }

  public static clear(): void {
    this.cache.clear();
  }
}

