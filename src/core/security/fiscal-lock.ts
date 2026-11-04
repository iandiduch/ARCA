import { loadConfig } from '../../app/config.js';
import { withAdvisoryLock } from './advisory-lock.js';

export class FiscalLock {
  /**
   * Ejecuta una operación fiscal bajo un bloqueo de exclusión mutua por Punto de Venta y Tipo de Comprobante,
   * evitando condiciones de carrera en getUltimoComprobante y asignación de CAE ante emisiones concurrentes.
   * Si el turno no se obtiene en FISCAL_LOCK_TIMEOUT_MS responde 503 RESOURCE_BUSY.
   */
  public static async withLock<T>(
    fiscalIdentityId: string,
    pointOfSaleNumber: number,
    voucherType: number,
    fn: () => Promise<T>
  ): Promise<T> {
    return withAdvisoryLock(`fiscal:${fiscalIdentityId}:${pointOfSaleNumber}:${voucherType}`, fn, {
      timeoutMs: loadConfig().FISCAL_LOCK_TIMEOUT_MS,
      busyMessage: `El punto de venta ${pointOfSaleNumber} está procesando otras emisiones del mismo tipo de comprobante. Reintente en unos segundos.`
    });
  }
}
