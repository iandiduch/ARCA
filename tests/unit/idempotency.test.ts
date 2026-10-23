import { describe, it, expect, beforeEach } from 'vitest';
import { IdempotencyService } from '../../src/core/security/idempotency-service.js';
import { getDatabase } from '../../src/infrastructure/database/connection.js';
import { tenants } from '../../src/infrastructure/database/schema/tenants.js';
import { idempotencyKeys } from '../../src/infrastructure/database/schema/idempotency-keys.js';

describe('IdempotencyService — Control de Concurrencia y Caché Idempotente', () => {
  let tenantId: string;

  beforeEach(async () => {
    const db = getDatabase();
    await db.delete(idempotencyKeys);
    await db.delete(tenants);

    const [t] = await db
      .insert(tenants)
      .values({
        name: 'Comercio Idempotente',
        slug: 'comercio-idempotente',
        status: 'ACTIVE'
      })
      .returning();
    tenantId = t!.id;
  });

  it('1. Reserva exitosa y control de solicitud en progreso', async () => {
    const key = 'pos-sale-uuid-001';

    // Primer intento: adquiere el bloqueo
    const firstTry = await IdempotencyService.acquire(tenantId, key, 'invoices');
    expect(firstTry.state).toBe('ACQUIRED');

    // Segundo intento concurrente con la misma clave: debe detectar que está en progreso
    const secondTry = await IdempotencyService.acquire(tenantId, key, 'invoices');
    expect(secondTry.state).toBe('IN_PROGRESS');
  });

  it('2. Completado y recuperación desde caché', async () => {
    const key = 'pos-sale-uuid-002';
    await IdempotencyService.acquire(tenantId, key, 'invoices');

    const fakeResponseBody = { id: 'inv-123', cae: '74123456789012', status: 'AUTHORIZED' };
    await IdempotencyService.complete(tenantId, key, 201, fakeResponseBody);

    // Reintento posterior: retorna el resultado cacheado
    const cachedTry = await IdempotencyService.acquire(tenantId, key, 'invoices');
    expect(cachedTry.state).toBe('CACHED');
    if (cachedTry.state === 'CACHED') {
      expect(cachedTry.statusCode).toBe(201);
      expect(cachedTry.responseBody).toEqual(fakeResponseBody);
    }
  });

  it('3. Liberación de clave ante error no persistente', async () => {
    const key = 'pos-sale-uuid-003';
    await IdempotencyService.acquire(tenantId, key, 'invoices');
    await IdempotencyService.release(tenantId, key);

    // Tras liberación, puede ser adquirida nuevamente
    const retry = await IdempotencyService.acquire(tenantId, key, 'invoices');
    expect(retry.state).toBe('ACQUIRED');
  });
});
