import crypto from 'node:crypto';
import { eq, and, gt, lte } from 'drizzle-orm';
import { getDatabase } from '../../infrastructure/database/connection.js';
import { idempotencyKeys } from '../../infrastructure/database/schema/idempotency-keys.js';
import { AppError } from '../errors/app-error.js';

export type IdempotencyAcquireResult =
  | { state: 'ACQUIRED' }
  | { state: 'IN_PROGRESS' }
  | { state: 'CACHED'; statusCode: number; responseBody: unknown };

export interface IdempotencyAcquireOptions {
  ttlHours?: number | undefined;
  /** Huella del payload: reutilizar la clave con un payload distinto es un error del cliente */
  requestHash?: string | undefined;
}

export class IdempotencyKeyMismatchError extends AppError {
  constructor() {
    super(
      'La clave de idempotencia ya fue utilizada con un payload distinto. Genere una clave nueva para cada operación.',
      422,
      'IDEMPOTENCY_KEY_MISMATCH'
    );
  }
}

/**
 * JSON con claves ordenadas, para que dos payloads equivalentes produzcan la misma huella.
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export class IdempotencyService {
  public static hashPayload(payload: unknown): string {
    return crypto.createHash('sha256').update(stableStringify(payload)).digest('hex');
  }

  /**
   * Intenta reservar una clave de idempotencia para evitar solicitudes concurrentes duplicadas.
   * Una clave vencida se reutiliza en el mismo upsert atómico.
   */
  public static async acquire(
    tenantId: string,
    key: string,
    resource: string = 'invoices',
    options: IdempotencyAcquireOptions = {}
  ): Promise<IdempotencyAcquireResult> {
    const db = getDatabase();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + (options.ttlHours ?? 24) * 3600 * 1000);
    const requestHash = options.requestHash ?? null;

    const [reserved] = await db
      .insert(idempotencyKeys)
      .values({ tenantId, key, resource, status: 'PROCESSING', requestHash, expiresAt })
      .onConflictDoUpdate({
        target: [idempotencyKeys.tenantId, idempotencyKeys.key],
        set: { resource, status: 'PROCESSING', statusCode: null, responseBody: null, requestHash, expiresAt, createdAt: now },
        where: lte(idempotencyKeys.expiresAt, now)
      })
      .returning({ id: idempotencyKeys.id });

    if (reserved) {
      return { state: 'ACQUIRED' };
    }

    // Existe una reserva vigente para esta clave
    const [existing] = await db
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.key, key), gt(idempotencyKeys.expiresAt, now)))
      .limit(1);

    if (!existing) {
      // Fue liberada o venció entre ambas consultas: reintentar la reserva
      return this.acquire(tenantId, key, resource, options);
    }

    if (requestHash && existing.requestHash && existing.requestHash !== requestHash) {
      throw new IdempotencyKeyMismatchError();
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
    options: IdempotencyAcquireOptions & { maxWaitMs?: number; pollIntervalMs?: number } = {}
  ): Promise<IdempotencyAcquireResult> {
    const maxWaitMs = options.maxWaitMs ?? 10000;
    const pollIntervalMs = options.pollIntervalMs ?? 100;
    const startTime = Date.now();
    while (Date.now() - startTime < maxWaitMs) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      const res = await this.acquire(tenantId, key, 'invoices', options);
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

  /**
   * Elimina las claves vencidas. Se ejecuta periódicamente desde el bootstrap.
   */
  public static async purgeExpired(): Promise<number> {
    const db = getDatabase();
    const deleted = await db
      .delete(idempotencyKeys)
      .where(lte(idempotencyKeys.expiresAt, new Date()))
      .returning({ id: idempotencyKeys.id });
    return deleted.length;
  }
}
