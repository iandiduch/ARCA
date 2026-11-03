import crypto from 'node:crypto';
import { hashApiKey } from './api-key.js';
import { loadConfig } from '../../app/config.js';
import { ApiKeyRepository } from '../../modules/tenants/infrastructure/api-key-repository.js';

const apiKeyRepo = new ApiKeyRepository();

/**
 * Credenciales que ya autenticaron con éxito (hash sha256). Sólo ellas obtienen un bucket de rate limit propio;
 * cualquier otra petición se limita por IP, de modo que rotar claves falsas no evade el límite.
 */
const MAX_KNOWN_KEYS = 10000;
const knownKeyHashes = new Map<string, true>();

export function rememberAuthenticatedKey(rawKey: string): void {
  const hash = hashApiKey(rawKey);
  if (knownKeyHashes.has(hash)) return;
  if (knownKeyHashes.size >= MAX_KNOWN_KEYS) {
    const oldest = knownKeyHashes.keys().next().value;
    if (oldest) knownKeyHashes.delete(oldest);
  }
  knownKeyHashes.set(hash, true);
}

export function extractRawApiKey(headers: Record<string, string | string[] | undefined>): string | undefined {
  const headerKey = headers['x-api-key'];
  if (typeof headerKey === 'string' && headerKey.trim().length > 0) {
    return headerKey.trim();
  }
  const authHeader = headers.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7).trim();
    return token.length > 0 ? token : undefined;
  }
  return undefined;
}

function isMasterKey(rawKey: string): boolean {
  const bufRaw = Buffer.from(rawKey);
  const bufMaster = Buffer.from(loadConfig().API_KEY_MASTER);
  return bufRaw.length === bufMaster.length && crypto.timingSafeEqual(bufRaw, bufMaster);
}

/**
 * Clave del bucket de rate limit. Una credencial válida obtiene su propio bucket desde la primera petición
 * (así un ataque desde la misma IP no bloquea a un POS legítimo); claves inexistentes caen en el bucket de la IP.
 */
export async function rateLimitKey(headers: Record<string, string | string[] | undefined>, ip: string): Promise<string> {
  const rawKey = extractRawApiKey(headers);
  if (!rawKey) {
    return `ip:${ip}`;
  }

  const hash = hashApiKey(rawKey);
  if (knownKeyHashes.has(hash)) {
    return `key:${hash}`;
  }

  try {
    if (isMasterKey(rawKey) || (await apiKeyRepo.findValidByHash(hash))) {
      rememberAuthenticatedKey(rawKey);
      return `key:${hash}`;
    }
  } catch {
    // Si la base no responde, limitar por IP; la autenticación devolverá el error correspondiente
  }
  return `ip:${ip}`;
}

export function clearKnownKeys(): void {
  knownKeyHashes.clear();
}
