import { TenantRepository } from '../infrastructure/tenant-repository.js';
import { ApiKeyRepository } from '../infrastructure/api-key-repository.js';
import { generateApiKey } from '../../../core/security/api-key.js';
import { AuditService } from '../../audit/application/audit-service.js';
import { ConflictError, NotFoundError, ValidationError } from '../../../core/errors/app-error.js';
import type { Tenant } from '../../../infrastructure/database/schema/tenants.js';

export interface CreateTenantInput {
  name: string;
  slug: string;
}

export interface CreateApiKeyInput {
  tenantId: string;
  name: string;
  role?: string | undefined;
  environment?: 'live' | 'test' | undefined;
}

export class TenantService {
  constructor(
    private readonly tenantRepo = new TenantRepository(),
    private readonly apiKeyRepo = new ApiKeyRepository()
  ) {}

  public async createTenant(input: CreateTenantInput, creatorId?: string): Promise<Tenant> {
    const slugRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
    const cleanSlug = input.slug.toLowerCase().trim();

    if (!slugRegex.test(cleanSlug)) {
      throw new ValidationError(
        'El slug del tenant debe contener únicamente letras minúsculas, números y guiones medios (ej: "onion-kiosco-1")'
      );
    }

    const existing = await this.tenantRepo.findBySlug(cleanSlug);
    if (existing) {
      throw new ConflictError(`Ya existe un comercio registrado con el slug "${cleanSlug}"`);
    }

    const created = await this.tenantRepo.create({
      name: input.name.trim(),
      slug: cleanSlug
    });

    await AuditService.record({
      tenantId: created.id,
      userId: creatorId,
      action: 'TENANT_CREATED',
      entityType: 'tenant',
      entityId: created.id,
      payload: { name: created.name, slug: created.slug }
    });

    return created;
  }

  public async getTenantById(id: string): Promise<Tenant> {
    const tenant = await this.tenantRepo.findById(id);
    if (!tenant) {
      throw new NotFoundError(`Comercio con ID "${id}" no encontrado`);
    }
    return tenant;
  }

  public async listTenants(limit = 50, offset = 0): Promise<Tenant[]> {
    return this.tenantRepo.list(limit, offset);
  }

  public async createApiKey(input: CreateApiKeyInput, creatorId?: string) {
    const tenant = await this.getTenantById(input.tenantId);
    if (!tenant.active) {
      throw new ValidationError('No se pueden generar API Keys para un comercio inactivo');
    }

    const generated = generateApiKey(input.environment ?? 'live');

    const created = await this.apiKeyRepo.create({
      tenantId: tenant.id,
      name: input.name.trim(),
      prefix: generated.prefix,
      keyHash: generated.keyHash,
      role: input.role ?? 'pos_client'
    });

    await AuditService.record({
      tenantId: tenant.id,
      userId: creatorId,
      apiKeyId: created.id,
      action: 'API_KEY_CREATED',
      entityType: 'api_key',
      entityId: created.id,
      payload: { name: created.name, prefix: created.prefix, role: created.role }
    });

    // Devuelve el rawKey únicamente en la respuesta de creación
    return {
      id: created.id,
      tenantId: created.tenantId,
      name: created.name,
      prefix: created.prefix,
      role: created.role,
      rawKey: generated.rawKey,
      createdAt: created.createdAt
    };
  }

  public async listApiKeys(tenantId: string) {
    return this.apiKeyRepo.listByTenant(tenantId);
  }

  public async revokeApiKey(tenantId: string, keyId: string, revokerId?: string): Promise<void> {
    const success = await this.apiKeyRepo.revoke(keyId, tenantId);
    if (!success) {
      throw new NotFoundError('API Key no encontrada para este comercio');
    }

    await AuditService.record({
      tenantId,
      userId: revokerId,
      apiKeyId: keyId,
      action: 'API_KEY_REVOKED',
      entityType: 'api_key',
      entityId: keyId
    });
  }
}
