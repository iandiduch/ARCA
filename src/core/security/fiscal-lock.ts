import { loadConfig } from '../../app/config.js';
import { withAdvisoryLock } from './advisory-lock.js';

export class FiscalLock {
  public static buildKey(
    /** resultado de sequenceOwner(identity): entorno + CUIT */
    owner: string,
    pointOfSaleNumber: number,
    voucherType: number
  ): string {
    return `fiscal:${owner}:${pointOfSaleNumber}:${voucherType}`;
  }

  /**
   * Ejecuta una operación fiscal bajo un bloqueo de exclusión mutua por Punto de Venta y Tipo de Comprobante,
   * evitando condiciones de carrera en getUltimoComprobante y asignación de CAE ante emisiones concurrentes.
   * Si el turno no se obtiene en FISCAL_LOCK_TIMEOUT_MS responde 503 RESOURCE_BUSY con Retry-After.
   * Utiliza una cola FIFO en proceso que previene el agotamiento de conexiones en el pool de locks.
   */
  public static async withLock<T>(
    owner: string,
    pointOfSaleNumber: number,
    voucherType: number,
    fn: () => Promise<T>
  ): Promise<T> {
    const config = loadConfig();
    return withAdvisoryLock(FiscalLock.buildKey(owner, pointOfSaleNumber, voucherType), fn, {
      timeoutMs: config.FISCAL_LOCK_TIMEOUT_MS,
      maxQueueSize: config.MAX_QUEUE_PER_SEQUENCE,
      retryAfterSeconds: 5,
      busyMessage: `El punto de venta ${pointOfSaleNumber} está procesando otras emisiones del mismo tipo de comprobante. Reintente en unos segundos.`
    });
  }
}
