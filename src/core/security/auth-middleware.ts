import crypto from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { loadConfig } from '../../app/config.js';
import { UnauthorizedError, ForbiddenError } from '../errors/app-error.js';
import { hashApiKey } from './api-key.js';
import { extractRawApiKey, rememberAuthenticatedKey } from './rate-limit-key.js';
import { ApiKeyRepository } from '../../modules/tenants/infrastructure/api-key-repository.js';
import { TenantRepository } from '../../modules/tenants/infrastructure/tenant-repository.js';
import type { Tenant } from '../../infrastructure/database/schema/tenants.js';

/**
 * Roles de API Key de comercio:
 * - admin: todo lo de pos_client + gestión de API Keys del comercio.
 * - pos_client: operación fiscal y comercial (emitir, catálogos, identidades fiscales).
 * - read_only: sólo lectura (GET/HEAD).
 */
export const API_KEY_ROLES = ['admin', 'pos_client', 'read_only'] as const;
export type ApiKeyRole = (typeof API_KEY_ROLES)[number];

const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

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
  const rawKey = extractRawApiKey(request.headers);

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
    rememberAuthenticatedKey(rawKey);

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

  const role = context.apiKey.role.toLowerCase();
  if (role === 'read_only' && !READ_ONLY_METHODS.has(request.method)) {
    throw new ForbiddenError('Esta API Key es de sólo lectura y no puede realizar operaciones de escritura');
  }

  rememberAuthenticatedKey(rawKey);
  request.tenant = context.tenant;
  request.authContext = {
    type: 'api_key',
    apiKeyId: context.apiKey.id,
    role
  };

  // Actualizar última fecha de uso en background
  void apiKeyRepo.updateLastUsed(context.apiKey.id).catch(() => {});
}

export async function requireMaster(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!request.authContext || request.authContext.type !== 'master') {
    throw new ForbiddenError('Operación restringida exclusivamente a la clave maestra de plataforma');
  }
}

export async function requireKeyAdmin(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const ctx = request.authContext;
  if (!ctx || (ctx.type !== 'master' && ctx.role !== 'admin')) {
    throw new ForbiddenError('La gestión de API Keys requiere la clave maestra o una API Key con rol "admin"');
  }
}

export async function requireTenant(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!request.tenant) {
    throw new ForbiddenError('Se requiere un comercio (tenant) autenticado y activo para esta operación');
  }
}
