import { describe, it, expect, afterAll } from 'vitest';
import { withAdvisoryLock, LockTimeoutError, getInProcessQueueLength } from '../../src/core/security/advisory-lock.js';
import { closeDatabaseConnection, getDatabasePoolStats, getLockPoolStats } from '../../src/infrastructure/database/connection.js';

describe('Bloqueo consultivo con espera acotada', () => {
  afterAll(async () => {
    await closeDatabaseConnection();
  });

  it('serializa las secciones críticas con el mismo nombre', async () => {
    const events: string[] = [];
    const task = (id: string) =>
      withAdvisoryLock(
        'test:serial',
        async () => {
          events.push(`start-${id}`);
          await new Promise((r) => setTimeout(r, 50));
          events.push(`end-${id}`);
        },
        { timeoutMs: 5000, busyMessage: 'ocupado' }
      );

    await Promise.all([task('a'), task('b')]);
    expect(events[1]).toMatch(/^end-/);
    expect(events[3]).toMatch(/^end-/);
  });

  it('responde 503 RESOURCE_BUSY si no obtiene el turno a tiempo', async () => {
    let release!: () => void;
    const held = withAdvisoryLock('test:busy', () => new Promise<void>((r) => (release = r)), {
      timeoutMs: 5000,
      busyMessage: 'ocupado'
    });
    await new Promise((r) => setTimeout(r, 50));

    const contender = withAdvisoryLock('test:busy', async () => 'nunca', { timeoutMs: 200, busyMessage: 'ocupado' });
    await expect(contender).rejects.toBeInstanceOf(LockTimeoutError);
    await expect(contender).rejects.toMatchObject({ statusCode: 503, code: 'RESOURCE_BUSY' });

    release();
    await held;
  });

  it('no consume conexiones del pool principal', async () => {
    const before = getDatabasePoolStats().total;
    await withAdvisoryLock('test:pool', async () => {
      expect(getDatabasePoolStats().total).toBe(before);
    }, { timeoutMs: 1000, busyMessage: 'ocupado' });
  });

  it('las peticiones en cola en proceso NO retienen conexiones del pool de bloqueos', async () => {
    let releaseHold!: () => void;
    const holdPromise = new Promise<void>((r) => (releaseHold = r));

    // Request activa para secuencia A
    const active = withAdvisoryLock(
      'test:queue:seqA',
      async () => {
        await holdPromise;
        return 'active-done';
      },
      { timeoutMs: 5000, busyMessage: 'ocupado' }
    );

    // Esperar a que active obtenga la conexión
    await new Promise((r) => setTimeout(r, 60));

    // Encolar 4 requests para la misma secuencia
    const queuedTasks = [1, 2, 3, 4].map((i) =>
      withAdvisoryLock(
        'test:queue:seqA',
        async () => `queued-${i}`,
        { timeoutMs: 5000, busyMessage: 'ocupado' }
      )
    );

    await new Promise((r) => setTimeout(r, 60));
    expect(getInProcessQueueLength('test:queue:seqA')).toBe(4);

    // Verificamos que sólo 1 conexión del lockPool está activa para esta secuencia
    const lockStats = getLockPoolStats();
    // total - idle = conexiones activas actualmente
    const activeConnections = lockStats.total - lockStats.idle;
    expect(activeConnections).toBeLessThanOrEqual(2); // a lo sumo 1 activa (+1 si otra prueba dejó una en idle)

    // Mientras seqA está tomada, seqB (otro comercio o punto de venta) puede emitir sin ser bloqueada
    let seqBExecuted = false;
    await withAdvisoryLock(
      'test:queue:seqB',
      async () => {
        seqBExecuted = true;
      },
      { timeoutMs: 2000, busyMessage: 'seqB ocupado' }
    );
    expect(seqBExecuted).toBe(true);

    // Liberar seqA
    releaseHold();
    await active;
    const results = await Promise.all(queuedTasks);
    expect(results).toEqual(['queued-1', 'queued-2', 'queued-3', 'queued-4']);
  });

  it('rechaza de inmediato con 503 y Retry-After si se supera maxQueueSize', async () => {
    let releaseHold!: () => void;
    const holdPromise = new Promise<void>((r) => (releaseHold = r));

    const active = withAdvisoryLock(
      'test:maxqueue',
      async () => {
        await holdPromise;
      },
      { timeoutMs: 5000, busyMessage: 'ocupado' }
    );
    await new Promise((r) => setTimeout(r, 50));

    // maxQueueSize = 2
    const q1 = withAdvisoryLock('test:maxqueue', async () => 'q1', { timeoutMs: 5000, busyMessage: 'ocupado', maxQueueSize: 2 });
    const q2 = withAdvisoryLock('test:maxqueue', async () => 'q2', { timeoutMs: 5000, busyMessage: 'ocupado', maxQueueSize: 2 });

    await new Promise((r) => setTimeout(r, 50));

    // La 3era excede maxQueueSize y debe fallar de inmediato
    const q3 = withAdvisoryLock('test:maxqueue', async () => 'q3', { timeoutMs: 5000, busyMessage: 'cola llena', maxQueueSize: 2, retryAfterSeconds: 3 });

    await expect(q3).rejects.toBeInstanceOf(LockTimeoutError);
    await expect(q3).rejects.toMatchObject({
      statusCode: 503,
      code: 'RESOURCE_BUSY',
      retryAfter: 3
    });

    releaseHold();
    await active;
    await Promise.all([q1, q2]);
  });
});
