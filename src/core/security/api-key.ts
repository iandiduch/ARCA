import crypto from 'node:crypto';

export interface GeneratedApiKey {
  rawKey: string;
  prefix: string;
  keyHash: string;
}

export function generateApiKey(environment: 'live' | 'test' = 'live'): GeneratedApiKey {
  // Prefijo identificador para reconocimiento visual y escaneo de secretos
  const randomPrefix = crypto.randomBytes(4).toString('hex'); // 8 caracteres hex
  const secret = crypto.randomBytes(24).toString('hex'); // 48 caracteres hex
  const prefix = `arca_${environment}_${randomPrefix}`;
  const rawKey = `${prefix}_${secret}`;

  const keyHash = hashApiKey(rawKey);

  return {
    rawKey,
    prefix,
    keyHash
  };
}

export function hashApiKey(rawKey: string): string {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

export function verifyApiKey(rawKey: string, storedHash: string): boolean {
  const computedHash = hashApiKey(rawKey);
  const bufA = Buffer.from(computedHash, 'hex');
  const bufB = Buffer.from(storedHash, 'hex');

  if (bufA.length !== bufB.length) {
    return false;
  }

  return crypto.timingSafeEqual(bufA, bufB);
}
