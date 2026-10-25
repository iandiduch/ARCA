import crypto from 'node:crypto';
import { getDatabasePool } from '../../infrastructure/database/connection.js';
import { logger } from '../../app/logger.js';

export class FiscalLock {
  /**
   * Ejecuta una operación fiscal bajo un bloqueo de exclusión mutua por Punto de Venta y Tipo de Comprobante,
   * evitando condiciones de carrera en getUltimoComprobante y asignación de CAE ante emisiones concurrentes.
   * Utiliza pg_advisory_lock sobre una conexión dedicada del pool.
   */
  public static async withLock<T>(
    fiscalIdentityId: string,
    pointOfSaleNumber: number,
    voucherType: number,
    fn: () => Promise<T>
  ): Promise<T> {
    const lockKey = `${fiscalIdentityId}:${pointOfSaleNumber}:${voucherType}`;
    const hash = crypto.createHash('sha256').update(lockKey).digest();
    const classId = hash.readInt32BE(0);
    const objId = hash.readInt32BE(4);

    const pool = getDatabasePool();
    const client = await pool.connect();

    try {
      logger.debug({ fiscalIdentityId, pointOfSaleNumber, voucherType }, 'Adquiriendo bloqueo fiscal exclusivo');
      await client.query('SELECT pg_advisory_lock($1, $2)', [classId, objId]);
      return await fn();
    } finally {
      try {
        await client.query('SELECT pg_advisory_unlock($1, $2)', [classId, objId]);
      } catch (unlockErr) {
        logger.error({ unlockErr, lockKey }, 'Error al liberar pg_advisory_unlock');
      } finally {
        client.release();
      }
    }
  }
}
