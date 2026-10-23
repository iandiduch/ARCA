import { eq } from 'drizzle-orm';
import { getDatabase } from '../../../infrastructure/database/connection.js';
import { tenants, type Tenant, type NewTenant } from '../../../infrastructure/database/schema/tenants.js';

export class TenantRepository {
  public async create(data: { name: string; slug: string }): Promise<Tenant> {
    const db = getDatabase();
    const [created] = await db
      .insert(tenants)
      .values({
        name: data.name,
        slug: data.slug.toLowerCase().trim()
      })
      .returning();

    if (!created) {
      throw new Error('Fallo al crear el tenant en base de datos');
    }

    return created;
  }

  public async findById(id: string): Promise<Tenant | null> {
    const db = getDatabase();
    const [found] = await db.select().from(tenants).where(eq(tenants.id, id)).limit(1);
    return found ?? null;
  }

  public async findBySlug(slug: string): Promise<Tenant | null> {
    const db = getDatabase();
    const [found] = await db
      .select()
      .from(tenants)
      .where(eq(tenants.slug, slug.toLowerCase().trim()))
      .limit(1);
    return found ?? null;
  }

  public async list(limit = 50, offset = 0): Promise<Tenant[]> {
    const db = getDatabase();
    return db.select().from(tenants).limit(limit).offset(offset);
  }

  public async update(id: string, data: Partial<Omit<NewTenant, 'id' | 'createdAt'>>): Promise<Tenant | null> {
    const db = getDatabase();
    const [updated] = await db
      .update(tenants)
      .set({
        ...data,
        updatedAt: new Date()
      })
      .where(eq(tenants.id, id))
      .returning();

    return updated ?? null;
  }
}
