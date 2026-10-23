import { describe, it, expect } from 'vitest';
import { generateApiKey, hashApiKey, verifyApiKey } from '../../src/core/security/api-key.js';

describe('Criptografía de API Keys (api-key.ts)', () => {
  it('debe generar una clave con formato correcto y entropía suficiente', () => {
    const key = generateApiKey('live');

    expect(key.rawKey).toMatch(/^arca_live_[0-9a-f]{8}_[0-9a-f]{48}$/);
    expect(key.prefix).toMatch(/^arca_live_[0-9a-f]{8}$/);
    expect(key.keyHash).toHaveLength(64); // SHA-256 hex
  });

  it('debe generar claves para entorno test con prefijo arca_test_', () => {
    const key = generateApiKey('test');
    expect(key.rawKey).toMatch(/^arca_test_[0-9a-f]{8}_[0-9a-f]{48}$/);
  });

  it('hashApiKey debe ser determinista para la misma clave', () => {
    const key = generateApiKey('live');
    const hash1 = hashApiKey(key.rawKey);
    const hash2 = hashApiKey(key.rawKey);
    expect(hash1).toBe(hash2);
    expect(hash1).toBe(key.keyHash);
  });

  it('verifyApiKey debe retornar true para clave válida y false para clave alterada', () => {
    const key = generateApiKey('live');
    expect(verifyApiKey(key.rawKey, key.keyHash)).toBe(true);

    const tampered = key.rawKey.slice(0, -1) + (key.rawKey.endsWith('a') ? 'b' : 'a');
    expect(verifyApiKey(tampered, key.keyHash)).toBe(false);
  });
});
