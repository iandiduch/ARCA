import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { loadConfig } from '../../app/config.js';
import { logger } from '../../app/logger.js';

const { Pool } = pg;
const config = loadConfig();

let pool: pg.Pool | null = null;
let lockPool: pg.Pool | null = null;
let dbInstance: ReturnType<typeof drizzle> | null = null;

export function getDatabasePool(): pg.Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: config.DATABASE_URL,
      max: config.DATABASE_MAX_CONNECTIONS,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      statement_timeout: config.DATABASE_STATEMENT_TIMEOUT_MS,
      query_timeout: config.DATABASE_STATEMENT_TIMEOUT_MS
    });

    pool.on('error', (err) => {
      logger.error({ err }, 'Error inesperado en el pool de PostgreSQL');
    });
  }

  return pool;
}

/**
 * Pool dedicado a bloqueos consultivos (pg_advisory_lock). Cada bloqueo retiene su conexión mientras dura,
 * así que se aísla del pool principal para no agotarlo durante llamadas lentas a ARCA.
 */
export function getLockPool(): pg.Pool {
  if (!lockPool) {
    lockPool = new Pool({
      connectionString: config.DATABASE_URL,
      max: config.DATABASE_LOCK_MAX_CONNECTIONS,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: config.FISCAL_LOCK_TIMEOUT_MS,
      statement_timeout: config.DATABASE_STATEMENT_TIMEOUT_MS
    });

    lockPool.on('error', (err) => {
      logger.error({ err }, 'Error inesperado en el pool de bloqueos de PostgreSQL');
    });
  }

  return lockPool;
}

export function getDatabase() {
  if (!dbInstance) {
    const currentPool = getDatabasePool();
    dbInstance = drizzle(currentPool);
  }
  return dbInstance;
}

export async function checkDatabaseConnection(): Promise<{
  ok: boolean;
  latencyMs?: number;
  error?: string;
}> {
  const start = Date.now();
  try {
    const currentPool = getDatabasePool();
    const client = await currentPool.connect();
    try {
      await client.query('SELECT 1');
      const latencyMs = Date.now() - start;
      return { ok: true, latencyMs };
    } finally {
      client.release();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error desconocido al conectar a PostgreSQL';
    return { ok: false, error: message };
  }
}

export function getDatabasePoolStats(): { total: number; idle: number; waiting: number } {
  if (!pool) {
    return { total: 0, idle: 0, waiting: 0 };
  }
  return {
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount
  };
}

export async function closeDatabaseConnection(): Promise<void> {
  if (lockPool) {
    await lockPool.end();
    lockPool = null;
  }
  if (pool) {
    await pool.end();
    pool = null;
    dbInstance = null;
    logger.info('Pool de conexiones de PostgreSQL cerrado correctamente');
  }
}
