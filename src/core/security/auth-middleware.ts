import crypto from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { loadConfig } from '../../app/config.js';
import { UnauthorizedError, ForbiddenError } from '../errors/app-error.js';
import { hashApiKey } from './api-key.js';
import { ApiKeyRepository } from '../../modules/tenants/infrastructure/api-key-repository.js';
import { TenantRepository } from '../../modules/tenants/infrastructure/tenant-repository.js';
import type { Tenant } from '../../infrastructure/database/schema/tenants.js';

export interface AuthContext {
  type: 'master' | 'api_key';
  apiKeyId?: string | undefined;
  role: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    tenant?: Tenant | undefined;
    authContext?: AuthContext | undefined;
  }
}

const config = loadConfig();
const apiKeyRepo = new ApiKeyRepository();
const tenantRepo = new TenantRepository();

export async function authenticate(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const headerKey = request.headers['x-api-key'];
  const authHeader = request.headers.authorization;

  let rawKey: string | undefined;

  if (typeof headerKey === 'string' && headerKey.trim().length > 0) {
    rawKey = headerKey.trim();
  } else if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    rawKey = authHeader.substring(7).trim();
  }

  if (!rawKey) {
    throw new UnauthorizedError('Credenciales ausentes. Debe proveer x-api-key o Authorization: Bearer <key>');
  }

  // 1. Verificación de Master Key (Plataforma) con protección contra Timing Attacks
  const bufRaw = Buffer.from(rawKey);
  const bufMaster = Buffer.from(config.API_KEY_MASTER);
  const isMasterKey = bufRaw.length === bufMaster.length && crypto.timingSafeEqual(bufRaw, bufMaster);

  if (isMasterKey) {
    request.authContext = {
      type: 'master',
      role: 'platform_admin'
    };

    // Si el administrador de plataforma envía x-tenant-id para operar en nombre de un comercio:
    const impersonateTenantId = request.headers['x-tenant-id'];
    if (typeof impersonateTenantId === 'string' && impersonateTenantId.trim().length > 0) {
      const foundTenant = await tenantRepo.findById(impersonateTenantId.trim());
      if (foundTenant && foundTenant.active) {
        request.tenant = foundTenant;
      }
    }
    return;
  }

  // 2. Verificación de API Key de Tenant
  const keyHash = hashApiKey(rawKey);
  const context = await apiKeyRepo.findValidByHash(keyHash);

  if (!context) {
    throw new UnauthorizedError('API Key inválida, revocada o vencida');
  }

  request.tenant = context.tenant;
  request.authContext = {
    type: 'api_key',
    apiKeyId: context.apiKey.id,
    role: context.apiKey.role
  };

  // Actualizar última fecha de uso en background
  void apiKeyRepo.updateLastUsed(context.apiKey.id).catch(() => {});
}

export async function requireMaster(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!request.authContext || request.authContext.type !== 'master') {
    throw new ForbiddenError('Operación restringida exclusivamente a la clave maestra de plataforma');
  }
}

export async function requireTenant(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!request.tenant) {
    throw new ForbiddenError('Se requiere un comercio (tenant) autenticado y activo para esta operación');
  }
}
