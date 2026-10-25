import { describe, it, expect } from 'vitest';
import { loadConfig, envSchema } from '../../src/app/config.js';

describe('Configurador de Entorno (config.ts)', () => {
  it('debe cargar la configuración por defecto correctamente', () => {
    const config = loadConfig();

    expect(config).toBeDefined();
    expect(config.PORT).toBeTypeOf('number');
    expect(config.HOST).toBeTypeOf('string');
    expect(['development', 'test', 'production']).toContain(config.NODE_ENV);
    expect(config.LOG_LEVEL).toBe('info');
    expect(['homologation', 'production']).toContain(config.ARCA_DEFAULT_ENVIRONMENT);
    expect(config.ARCA_PLATFORM_CUIT).toMatch(/^\d{11}$/);
  });

  it('debe contener la clave de cifrado de 64 caracteres hex', () => {
    const config = loadConfig();
    expect(config.ENCRYPTION_KEY).toHaveLength(64);
    expect(config.CORS_ORIGIN).toBeDefined();
    expect(config.DATABASE_STATEMENT_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('debe rechazar claves maestras por defecto en entorno de producción', () => {
    const invalidProd = envSchema.safeParse({
      NODE_ENV: 'production',
      API_KEY_MASTER: 'dev-master-secret-key-change-in-production'
    });
    expect(invalidProd.success).toBe(false);
  });

  it('debe aceptar claves configuradas correctamente en entorno de producción', () => {
    const validProd = envSchema.safeParse({
      NODE_ENV: 'production',
      API_KEY_MASTER: 'super-secret-production-master-key-12345678',
      ENCRYPTION_KEY: 'a'.repeat(64),
      DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/arca_db'
    });
    expect(validProd.success).toBe(true);
  });
});
