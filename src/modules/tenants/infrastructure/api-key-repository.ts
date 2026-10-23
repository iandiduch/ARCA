import { eq, and } from 'drizzle-orm';
import { getDatabase } from '../../../infrastructure/database/connection.js';
import { apiKeys, type ApiKey, type NewApiKey } from '../../../infrastructure/database/schema/api-keys.js';
import { tenants, type Tenant } from '../../../infrastructure/database/schema/tenants.js';

export interface AuthenticatedApiKeyContext {
  apiKey: ApiKey;
  tenant: Tenant;
}

export class ApiKeyRepository {
  public async create(data: {
    tenantId: string;
    name: string;
    prefix: string;
    keyHash: string;
    role?: string;
    expiresAt?: Date | null;
  }): Promise<ApiKey> {
    const db = getDatabase();
    const values: NewApiKey = {
      tenantId: data.tenantId,
      name: data.name,
      prefix: data.prefix,
      keyHash: data.keyHash,
      role: data.role ?? 'pos_client',
      expiresAt: data.expiresAt ?? null
    };

    const [created] = await db.insert(apiKeys).values(values).returning();
    if (!created) {
      throw new Error('Fallo al persistir la API Key');
    }
    return created;
  }

  public async findValidByHash(keyHash: string): Promise<AuthenticatedApiKeyContext | null> {
    const db = getDatabase();
    const rows = await db
      .select({
        apiKey: apiKeys,
        tenant: tenants
      })
      .from(apiKeys)
      .innerJoin(tenants, eq(apiKeys.tenantId, tenants.id))
      .where(and(eq(apiKeys.keyHash, keyHash), eq(apiKeys.active, true), eq(tenants.active, true)))
      .limit(1);

    const first = rows[0];
    if (!first) return null;

    // Verificar si expiró
    if (first.apiKey.expiresAt && first.apiKey.expiresAt.getTime() <= Date.now()) {
      return null;
    }

    return first;
  }

  public async listByTenant(tenantId: string): Promise<Omit<ApiKey, 'keyHash'>[]> {
    const db = getDatabase();
    const rows = await db
      .select({
        id: apiKeys.id,
        tenantId: apiKeys.tenantId,
        name: apiKeys.name,
        prefix: apiKeys.prefix,
        role: apiKeys.role,
        active: apiKeys.active,
        expiresAt: apiKeys.expiresAt,
        createdAt: apiKeys.createdAt,
        lastUsedAt: apiKeys.lastUsedAt
      })
      .from(apiKeys)
      .where(eq(apiKeys.tenantId, tenantId));

    return rows;
  }

  public async revoke(id: string, tenantId: string): Promise<boolean> {
    const db = getDatabase();
    const [updated] = await db
      .update(apiKeys)
      .set({ active: false })
      .where(and(eq(apiKeys.id, id), eq(apiKeys.tenantId, tenantId)))
      .returning();

    return Boolean(updated);
  }

  public async updateLastUsed(id: string): Promise<void> {
    const db = getDatabase();
    await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, id));
  }
}
