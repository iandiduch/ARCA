import { describe, it, expect } from 'vitest';
import { EncryptionService } from '../../src/core/security/encryption.js';

describe('Cifrado de Claves Privadas en Reposo (EncryptionService - AES-256-GCM)', () => {
  it('debe cifrar y descifrar una cadena en texto plano manteniendo la integridad', () => {
    const secret = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0...test\n-----END RSA PRIVATE KEY-----';

    const encrypted = EncryptionService.encrypt(secret);
    expect(encrypted.ciphertext).toBeDefined();
    expect(encrypted.iv).toHaveLength(24); // 12 bytes = 24 hex
    expect(encrypted.authTag).toHaveLength(32); // 16 bytes = 32 hex

    const decrypted = EncryptionService.decrypt(encrypted);
    expect(decrypted).toBe(secret);
  });

  it('debe fallar si el texto cifrado o el authTag han sido manipulados', () => {
    const secret = 'clave_secreta_arca';
    const encrypted = EncryptionService.encrypt(secret);

    // Manipular ciphertext
    const tampered = {
      ...encrypted,
      ciphertext: encrypted.ciphertext.slice(0, -2) + 'ff'
    };

    expect(() => EncryptionService.decrypt(tampered)).toThrow();
  });
});
