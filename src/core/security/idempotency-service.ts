import { eq, and, gt } from 'drizzle-orm';
import { getDatabase } from '../../infrastructure/database/connection.js';
import { idempotencyKeys, type IdempotencyKey } from '../../infrastructure/database/schema/idempotency-keys.js';

export type IdempotencyAcquireResult =
  | { state: 'ACQUIRED' }
  | { state: 'IN_PROGRESS' }
  | { state: 'CACHED'; statusCode: number; responseBody: unknown };

export class IdempotencyService {
  /**
   * Intenta reservar una clave de idempotencia para evitar solicitudes concurrentes duplicadas
   */
  public static async acquire(
    tenantId: string,
    key: string,
    resource: string = 'invoices',
    ttlHours: number = 24
  ): Promise<IdempotencyAcquireResult> {
    const db = getDatabase();
    const now = new Date();

    const [existing] = await db
      .select()
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.tenantId, tenantId),
          eq(idempotencyKeys.key, key),
          gt(idempotencyKeys.expiresAt, now)
        )
      )
      .limit(1);

    if (!existing) {
      const expiresAt = new Date(now.getTime() + ttlHours * 3600 * 1000);
      try {
        await db.insert(idempotencyKeys).values({
          tenantId,
          key,
          resource,
          status: 'PROCESSING',
          expiresAt
        });
        return { state: 'ACQUIRED' };
      } catch {
        // En caso de carrera concurrente entre dos inserts simultáneos
        return { state: 'IN_PROGRESS' };
      }
    }

    if (existing.status === 'COMPLETED' && existing.statusCode && existing.responseBody) {
      return {
        state: 'CACHED',
        statusCode: existing.statusCode,
        responseBody: existing.responseBody
      };
    }

    return { state: 'IN_PROGRESS' };
  }

  /**
   * Espera activamente si una clave de idempotencia se encuentra en procesamiento por otra petición concurrente
   */
  public static async waitForCompletion(
    tenantId: string,
    key: string,
    maxWaitMs: number = 10000,
    pollIntervalMs: number = 100
  ): Promise<IdempotencyAcquireResult> {
    const startTime = Date.now();
    while (Date.now() - startTime < maxWaitMs) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      const res = await this.acquire(tenantId, key);
      if (res.state === 'CACHED' || res.state === 'ACQUIRED') {
        return res;
      }
    }
    return { state: 'IN_PROGRESS' };
  }

  /**
   * Registra el resultado exitoso de la operación idempotente para responder de inmediato en futuros reintentos
   */
  public static async complete(
    tenantId: string,
    key: string,
    statusCode: number,
    responseBody: unknown
  ): Promise<void> {
    const db = getDatabase();
    await db
      .update(idempotencyKeys)
      .set({
        status: 'COMPLETED',
        statusCode,
        responseBody
      })
      .where(and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.key, key)));
  }

  /**
   * Libera la clave de idempotencia si la operación falló antes de consumir efectos permanentes
   */
  public static async release(tenantId: string, key: string): Promise<void> {
    const db = getDatabase();
    await db
      .delete(idempotencyKeys)
      .where(and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.key, key)));
  }
}
