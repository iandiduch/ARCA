import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { IdempotencyService } from '../../src/core/security/idempotency-service.js';
import { getDatabase } from '../../src/infrastructure/database/connection.js';
import { tenants } from '../../src/infrastructure/database/schema/tenants.js';
import { idempotencyKeys } from '../../src/infrastructure/database/schema/idempotency-keys.js';
import { invoices } from '../../src/infrastructure/database/schema/invoices.js';

describe('IdempotencyService — Control de Concurrencia y Caché Idempotente', () => {
  let tenantId: string;

  beforeEach(async () => {
    const db = getDatabase();
    await db.delete(idempotencyKeys);
    await db.delete(invoices);
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

  it('4. Una clave vencida se puede volver a reservar (no queda en 409 permanente)', async () => {
    const key = 'pos-sale-uuid-004';
    await IdempotencyService.acquire(tenantId, key, 'invoices');
    await getDatabase()
      .update(idempotencyKeys)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(idempotencyKeys.key, key));

    const retry = await IdempotencyService.acquire(tenantId, key, 'invoices');
    expect(retry.state).toBe('ACQUIRED');
  });

  it('5. Reutilizar la clave con otro payload es rechazado', async () => {
    const key = 'pos-sale-uuid-005';
    const hashA = IdempotencyService.hashPayload({ items: [{ unitPrice: 100 }], voucherType: 6 });
    const hashSameOtherOrder = IdempotencyService.hashPayload({ voucherType: 6, items: [{ unitPrice: 100 }] });
    const hashB = IdempotencyService.hashPayload({ items: [{ unitPrice: 999 }], voucherType: 6 });
    expect(hashSameOtherOrder).toBe(hashA);

    await IdempotencyService.acquire(tenantId, key, 'invoices', { requestHash: hashA });
    await expect(IdempotencyService.acquire(tenantId, key, 'invoices', { requestHash: hashB })).rejects.toMatchObject({
      statusCode: 422,
      code: 'IDEMPOTENCY_KEY_MISMATCH'
    });
    const sameRetry = await IdempotencyService.acquire(tenantId, key, 'invoices', { requestHash: hashA });
    expect(sameRetry.state).toBe('IN_PROGRESS');
  });

  it('6. Purga las claves vencidas', async () => {
    await IdempotencyService.acquire(tenantId, 'vieja', 'invoices', { ttlHours: -1 });
    await IdempotencyService.acquire(tenantId, 'vigente', 'invoices');
    expect(await IdempotencyService.purgeExpired()).toBe(1);
    const rows = await getDatabase().select().from(idempotencyKeys);
    expect(rows.map((r) => r.key)).toEqual(['vigente']);
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
