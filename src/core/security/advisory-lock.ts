import crypto from 'node:crypto';
import type pg from 'pg';
import { getLockPool } from '../../infrastructure/database/connection.js';
import { AppError } from '../errors/app-error.js';
import { logger } from '../../app/logger.js';

export class LockTimeoutError extends AppError {
  public readonly retryAfter: number;

  constructor(message: string, retryAfter = 5) {
    super(message, 503, 'RESOURCE_BUSY');
    this.retryAfter = retryAfter;
  }
}

export interface AdvisoryLockOptions {
  timeoutMs: number;
  busyMessage: string;
  maxQueueSize?: number;
  retryAfterSeconds?: number;
}

interface LockWaiter {
  resolve: () => void;
  reject: (err: Error) => void;
  deadline: number;
  timer: NodeJS.Timeout;
}

interface InProcessLockQueue {
  active: boolean;
  waiters: LockWaiter[];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const lockQueues = new Map<string, InProcessLockQueue>();

export function getInProcessQueueLength(lockName: string): number {
  return lockQueues.get(lockName)?.waiters.length ?? 0;
}

export function clearInProcessQueues(): void {
  for (const queue of lockQueues.values()) {
    for (const w of queue.waiters) {
      clearTimeout(w.timer);
    }
  }
  lockQueues.clear();
}

function dispatchNextWaiter(lockName: string, queue: InProcessLockQueue): void {
  while (queue.waiters.length > 0) {
    const next = queue.waiters.shift()!;
    if (Date.now() >= next.deadline) {
      next.reject(new LockTimeoutError('Tiempo de espera agotado en cola de bloqueo', 5));
      continue;
    }
    // Ceder el estado activo directamente al siguiente en la cola FIFO
    next.resolve();
    return;
  }

  queue.active = false;
  lockQueues.delete(lockName);
}

/**
 * Ejecuta `fn` adquiriendo bloqueos consultivos de PostgreSQL para un conjunto de recursos (`lockNames`)
 * utilizando EXACTAMENTE UNA conexión del pool de bloqueos.
 *
 * 1. Ordena las claves alfabéticamente para evitar interbloqueos (deadlocks) tanto en proceso como en Postgres.
 * 2. Encola en proceso (FIFO) para que quienes esperan no consuman conexiones de base de datos.
 * 3. Al llegar su turno en todas las claves, toma 1 sola conexión de Postgres y aplica pg_try_advisory_lock
 *    sobre cada clave.
 * 4. Al finalizar, libera todos los bloqueos en orden inverso y cede los turnos de cola.
 */
export async function withAdvisoryLocks<T>(
  lockNames: string[],
  fn: () => Promise<T>,
  options: AdvisoryLockOptions
): Promise<T> {
  if (!lockNames || lockNames.length === 0) {
    return fn();
  }

  // Orden determinista lexicográfico para prevenir deadlocks
  const uniqueNames = Array.from(new Set(lockNames)).sort();
  const deadline = Date.now() + options.timeoutMs;
  const retryAfter = options.retryAfterSeconds ?? 5;
  const maxQueueSize = options.maxQueueSize ?? 10;

  // 1. Encolar en proceso por cada clave (FIFO)
  const acquiredQueues: Array<{ name: string; queue: InProcessLockQueue }> = [];

  try {
    for (const name of uniqueNames) {
      let queue = lockQueues.get(name);
      if (!queue) {
        queue = { active: false, waiters: [] };
        lockQueues.set(name, queue);
      }

      if (queue.active) {
        if (queue.waiters.length >= maxQueueSize) {
          throw new LockTimeoutError(options.busyMessage, retryAfter);
        }

        await new Promise<void>((resolve, reject) => {
          const waitMs = Math.max(0, deadline - Date.now());
          let timer: NodeJS.Timeout;
          const waiter: LockWaiter = {
            resolve: () => {
              clearTimeout(timer);
              resolve();
            },
            reject: (err: Error) => {
              clearTimeout(timer);
              reject(err);
            },
            deadline,
            timer: null as any
          };
          timer = setTimeout(() => {
            if (queue) {
              const idx = queue.waiters.indexOf(waiter);
              if (idx !== -1) queue.waiters.splice(idx, 1);
              if (!queue.active && queue.waiters.length === 0) {
                lockQueues.delete(name);
              }
            }
            reject(new LockTimeoutError(options.busyMessage, retryAfter));
          }, waitMs);
          waiter.timer = timer;
          queue!.waiters.push(waiter);
        });
      }

      queue.active = true;
      acquiredQueues.push({ name, queue });
    }

    // 2. Tomar UNA SOLA conexión de PostgreSQL para todos los bloqueos consultivos
    let client: pg.PoolClient;
    try {
      client = await getLockPool().connect();
    } catch (err) {
      logger.warn({ err, lockNames: uniqueNames }, 'No hay conexiones disponibles en el pool de bloqueos');
      throw new LockTimeoutError(options.busyMessage, retryAfter);
    }

    let releaseError: Error | undefined;
    const lockedPairs: Array<{ classId: number; objId: number; name: string }> = [];

    try {
      for (const name of uniqueNames) {
        const hash = crypto.createHash('sha256').update(name).digest();
        const classId = hash.readInt32BE(0);
        const objId = hash.readInt32BE(4);
        let delayMs = 25;
        for (;;) {
          const res = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1, $2) AS ok', [classId, objId]);
          if (res.rows[0]?.ok) {
            lockedPairs.push({ classId, objId, name });
            break;
          }
          if (Date.now() >= deadline) {
            throw new LockTimeoutError(options.busyMessage, retryAfter);
          }
          await sleep(Math.min(delayMs, Math.max(0, deadline - Date.now())));
          delayMs = Math.min(delayMs * 2, 200);
        }
      }

      return await fn();
    } finally {
      // Liberar en orden inverso todos los locks tomados en PostgreSQL sobre esta conexión
      for (const { classId, objId, name } of lockedPairs.reverse()) {
        try {
          await client.query('SELECT pg_advisory_unlock($1, $2)', [classId, objId]);
        } catch (unlockErr) {
          logger.error({ err: unlockErr, name }, 'Error al liberar pg_advisory_unlock; se descarta la conexión');
          releaseError = unlockErr instanceof Error ? unlockErr : new Error(String(unlockErr));
        }
      }
      client.release(releaseError);
    }
  } finally {
    // Liberar en orden inverso las colas en proceso adquiridas
    for (const { name, queue } of acquiredQueues.reverse()) {
      dispatchNextWaiter(name, queue);
    }
  }
}

/**
 * Ejecuta `fn` con un bloqueo consultivo de PostgreSQL (válido entre réplicas) identificado por `lockName`.
 * Encola en proceso por clave (FIFO) para que las peticiones en espera no consuman conexiones del pool de bloqueos
 * y evita la inanición entre comercios (DoS multi-tenant).
 */
export async function withAdvisoryLock<T>(
  lockName: string,
  fn: () => Promise<T>,
  options: AdvisoryLockOptions
): Promise<T> {
  return withAdvisoryLocks([lockName], fn, options);
}
