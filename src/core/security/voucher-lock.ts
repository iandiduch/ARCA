import { loadConfig } from '../../app/config.js';
import { withAdvisoryLocks } from './advisory-lock.js';

export interface AssociatedVoucherRef {
  pointOfSale: number;
  voucherType: number;
  voucherNumber: number;
}

export class AssociatedVoucherLock {
  public static buildKey(
    /** resultado de sequenceOwner(identity): entorno + CUIT */
    owner: string,
    pointOfSale: number,
    voucherType: number,
    voucherNumber: number
  ): string {
    return `voucher:${owner}:${pointOfSale}:${voucherType}:${voucherNumber}`;
  }

  /**
   * Serializa operaciones que afecten al mismo comprobante original (p. ej. múltiples Notas de Crédito
   * emitidas en simultáneo desde distintos puntos de venta sobre la misma factura).
   * Bloquea por clave única del comprobante original utilizando EXACTAMENTE UNA conexión del pool de bloqueos.
   */
  public static async withLock<T>(
    owner: string,
    associatedVouchers: AssociatedVoucherRef[],
    fn: () => Promise<T>
  ): Promise<T> {
    if (!associatedVouchers || associatedVouchers.length === 0) {
      return fn();
    }

    const uniqueKeys = Array.from(
      new Set(
        associatedVouchers.map((a) =>
          AssociatedVoucherLock.buildKey(owner, a.pointOfSale, a.voucherType, a.voucherNumber)
        )
      )
    ).sort();

    const config = loadConfig();
    return withAdvisoryLocks(uniqueKeys, fn, {
      timeoutMs: config.FISCAL_LOCK_TIMEOUT_MS,
      maxQueueSize: config.MAX_QUEUE_PER_SEQUENCE,
      retryAfterSeconds: 3,
      busyMessage: 'El comprobante original está siendo procesado por otra emisión de nota de crédito. Reintente en unos segundos.'
    });
  }
}

