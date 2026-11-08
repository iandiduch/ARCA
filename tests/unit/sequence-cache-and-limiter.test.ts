import { describe, it, expect, beforeEach } from 'vitest';
import { SequenceNumberCache, sequenceOwner } from '../../src/core/fiscal/sequence-cache.js';
import { FiscalLock } from '../../src/core/security/fiscal-lock.js';
import { TenantInFlightLimiter } from '../../src/core/security/tenant-in-flight.js';

describe('SequenceNumberCache & TenantInFlightLimiter', () => {
  beforeEach(() => {
    SequenceNumberCache.clear();
    TenantInFlightLimiter.reset();
  });

  describe('SequenceNumberCache', () => {
    it('almacena y recupera el último número autorizado por secuencia', () => {
      const key = SequenceNumberCache.buildKey('ident-1', 1, 6);
      expect(SequenceNumberCache.get(key)).toBeUndefined();

      SequenceNumberCache.set(key, 105);
      expect(SequenceNumberCache.get(key)).toBe(105);

      SequenceNumberCache.invalidate(key);
      expect(SequenceNumberCache.get(key)).toBeUndefined();
    });

    it('N4 – dos identidades con el mismo CUIT y entorno comparten la secuencia; homologación y producción no', () => {
      const tenantA = sequenceOwner({ cuit: '30-71234567-5', environment: 'production' });
      const tenantB = sequenceOwner({ cuit: '30712345675', environment: 'production' });
      const homo = sequenceOwner({ cuit: '30712345675', environment: 'homologation' });
      expect(tenantA).toBe(tenantB);
      expect(homo).not.toBe(tenantA);
      expect(FiscalLock.buildKey(tenantA, 3, 6)).toBe(FiscalLock.buildKey(tenantB, 3, 6));
      expect(SequenceNumberCache.buildKey(homo, 3, 6)).not.toBe(SequenceNumberCache.buildKey(tenantA, 3, 6));
    });

    it('clear() limpia todas las secuencias almacenadas', () => {
      const k1 = SequenceNumberCache.buildKey('ident-1', 1, 6);
      const k2 = SequenceNumberCache.buildKey('ident-2', 2, 1);
      SequenceNumberCache.set(k1, 50);
      SequenceNumberCache.set(k2, 80);

      SequenceNumberCache.clear();
      expect(SequenceNumberCache.get(k1)).toBeUndefined();
      expect(SequenceNumberCache.get(k2)).toBeUndefined();
    });
  });

  describe('TenantInFlightLimiter', () => {
    it('controla el número máximo de emisiones en curso por tenant', () => {
      const tenant = 'tenant-xyz';
      const max = 3;

      expect(TenantInFlightLimiter.tryAcquire(tenant, max)).toBe(true);
      expect(TenantInFlightLimiter.tryAcquire(tenant, max)).toBe(true);
      expect(TenantInFlightLimiter.tryAcquire(tenant, max)).toBe(true);
      expect(TenantInFlightLimiter.getInFlight(tenant)).toBe(3);

      // Supera el límite: debe rechazar
      expect(TenantInFlightLimiter.tryAcquire(tenant, max)).toBe(false);

      // Otro tenant no se ve afectado
      expect(TenantInFlightLimiter.tryAcquire('tenant-otro', max)).toBe(true);

      // Al liberar, permite un nuevo slot
      TenantInFlightLimiter.release(tenant);
      expect(TenantInFlightLimiter.getInFlight(tenant)).toBe(2);
      expect(TenantInFlightLimiter.tryAcquire(tenant, max)).toBe(true);
    });
  });
});

