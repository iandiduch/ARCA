import crypto from 'node:crypto';
import type pg from 'pg';
import { getLockPool } from '../../infrastructure/database/connection.js';
import { AppError } from '../errors/app-error.js';
import { logger } from '../../app/logger.js';

export class LockTimeoutError extends AppError {
  constructor(message: string) {
    super(message, 503, 'RESOURCE_BUSY');
  }
}

export interface AdvisoryLockOptions {
  timeoutMs: number;
  busyMessage: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ejecuta `fn` con un bloqueo consultivo de PostgreSQL (válido entre réplicas) identificado por `lockName`.
 * Se usa pg_try_advisory_lock con reintentos hasta `timeoutMs` en lugar de pg_advisory_lock bloqueante,
 * para que la espera no quede sujeta a statement_timeout y termine en un 503 claro.
 */
export async function withAdvisoryLock<T>(
  lockName: string,
  fn: () => Promise<T>,
  options: AdvisoryLockOptions
): Promise<T> {
  const hash = crypto.createHash('sha256').update(lockName).digest();
  const classId = hash.readInt32BE(0);
  const objId = hash.readInt32BE(4);
  const deadline = Date.now() + options.timeoutMs;

  let client: pg.PoolClient;
  try {
    client = await getLockPool().connect();
  } catch (err) {
    logger.warn({ err, lockName }, 'No hay conexiones disponibles en el pool de bloqueos');
    throw new LockTimeoutError(options.busyMessage);
  }

  let releaseError: Error | undefined;
  try {
    let delayMs = 25;
    for (;;) {
      const res = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1, $2) AS ok', [classId, objId]);
      if (res.rows[0]?.ok) break;
      if (Date.now() >= deadline) {
        throw new LockTimeoutError(options.busyMessage);
      }
      await sleep(Math.min(delayMs, Math.max(0, deadline - Date.now())));
      delayMs = Math.min(delayMs * 2, 500);
    }

    try {
      return await fn();
    } finally {
      try {
        await client.query('SELECT pg_advisory_unlock($1, $2)', [classId, objId]);
      } catch (unlockErr) {
        // Destruir la conexión garantiza que PostgreSQL libere el bloqueo de sesión
        logger.error({ err: unlockErr, lockName }, 'Error al liberar pg_advisory_unlock; se descarta la conexión');
        releaseError = unlockErr instanceof Error ? unlockErr : new Error(String(unlockErr));
      }
    }
  } finally {
    client.release(releaseError);
  }
}
