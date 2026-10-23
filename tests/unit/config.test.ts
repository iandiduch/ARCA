import { describe, it, expect } from 'vitest';
import { loadConfig } from '../../src/app/config.js';

describe('Configurador de Entorno (config.ts)', () => {
  it('debe cargar la configuración por defecto correctamente', () => {
    const config = loadConfig();

    expect(config).toBeDefined();
    expect(config.PORT).toBeTypeOf('number');
    expect(config.HOST).toBeTypeOf('string');
    expect(['development', 'test', 'production']).toContain(config.NODE_ENV);
    expect(config.LOG_LEVEL).toBe('info');
    expect(config.ARCA_DEFAULT_ENVIRONMENT).toBe('homologation');
    expect(config.ARCA_PLATFORM_CUIT).toMatch(/^\d{11}$/);
  });

  it('debe contener la clave de cifrado de 64 caracteres hex', () => {
    const config = loadConfig();
    expect(config.ENCRYPTION_KEY).toHaveLength(64);
  });
});
