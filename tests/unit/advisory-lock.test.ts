import { describe, it, expect, afterAll } from 'vitest';
import { withAdvisoryLock, LockTimeoutError } from '../../src/core/security/advisory-lock.js';
import { closeDatabaseConnection, getDatabasePoolStats } from '../../src/infrastructure/database/connection.js';

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
});
