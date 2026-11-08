import { describe, it, expect } from 'vitest';
import { WsaaClient } from '../../src/modules/arca/infrastructure/wsaa/wsaa-client.js';
import { envSchema, isArcaProductionAllowed, type AppConfig } from '../../src/app/config.js';

describe('Guard de ARCA producción (ALLOW_ARCA_PRODUCTION)', () => {
  it('sin el flag sólo NODE_ENV=production habilita producción; el flag explícito manda siempre', () => {
    const cfg = (NODE_ENV: string, ALLOW_ARCA_PRODUCTION?: 'true' | 'false') =>
      ({ NODE_ENV, ALLOW_ARCA_PRODUCTION }) as AppConfig;
    expect(isArcaProductionAllowed(cfg('production'))).toBe(true);
    expect(isArcaProductionAllowed(cfg('test'))).toBe(false);
    expect(isArcaProductionAllowed(cfg('production', 'false'))).toBe(false); // staging con la imagen de producción
    expect(isArcaProductionAllowed(cfg('development', 'true'))).toBe(true);
  });

  it('ALLOW_ARCA_PRODUCTION vacío (docker compose sin la variable) no rompe la configuración', () => {
    expect(envSchema.safeParse({ ...process.env, ALLOW_ARCA_PRODUCTION: '' }).success).toBe(true);
    expect(envSchema.safeParse({ ...process.env, ALLOW_ARCA_PRODUCTION: 'quizas' }).success).toBe(false);
  });

  it('una instalación no habilitada no pide credenciales WSAA de producción (aunque la identidad ya exista en la base)', async () => {
    await expect(
      WsaaClient.getTicket('identidad-restaurada-de-un-backup', 'pk', 'cert', { environment: 'production', service: 'wsfe' })
    ).rejects.toThrow(/no está habilitada para operar contra ARCA producción/);
  });
});
