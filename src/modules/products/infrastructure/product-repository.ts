import { eq, and, or, ilike } from 'drizzle-orm';
import { getDatabase } from '../../../infrastructure/database/connection.js';
import { products, type Product, type NewProduct } from '../../../infrastructure/database/schema/products.js';

export interface ListProductsOptions {
  search?: string | undefined;
  barcode?: string | undefined;
  activeOnly?: boolean | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export class ProductRepository {
  public async create(data: NewProduct): Promise<Product> {
    const db = getDatabase();
    const [created] = await db.insert(products).values(data).returning();
    if (!created) {
      throw new Error('Fallo al registrar producto');
    }
    return created;
  }

  public async findById(tenantId: string, id: string): Promise<Product | null> {
    const db = getDatabase();
    const [found] = await db
      .select()
      .from(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.id, id)))
      .limit(1);

    return found ?? null;
  }

  public async findByInternalCode(tenantId: string, code: string): Promise<Product | null> {
    const db = getDatabase();
    const [found] = await db
      .select()
      .from(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.internalCode, code.trim())))
      .limit(1);

    return found ?? null;
  }

  public async findByBarcode(tenantId: string, barcode: string): Promise<Product | null> {
    const db = getDatabase();
    const [found] = await db
      .select()
      .from(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.barcode, barcode.trim())))
      .limit(1);

    return found ?? null;
  }

  public async list(tenantId: string, options?: ListProductsOptions): Promise<Product[]> {
    const db = getDatabase();
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;

    const conditions = [eq(products.tenantId, tenantId)];

    if (options?.activeOnly !== false) {
      conditions.push(eq(products.active, true));
    }

    if (options?.barcode) {
      conditions.push(eq(products.barcode, options.barcode.trim()));
    }

    if (options?.search) {
      const q = `%${options.search}%`;
      conditions.push(
        or(
          ilike(products.name, q),
          ilike(products.internalCode, q),
          ilike(products.barcode, q),
          ilike(products.description, q)
        )!
      );
    }

    return db
      .select()
      .from(products)
      .where(and(...conditions))
      .limit(limit)
      .offset(offset);
  }

  public async update(
    tenantId: string,
    id: string,
    data: Partial<Omit<NewProduct, 'id' | 'tenantId' | 'createdAt'>>
  ): Promise<Product | null> {
    const db = getDatabase();
    const [updated] = await db
      .update(products)
      .set({
        ...data,
        updatedAt: new Date()
      })
      .where(and(eq(products.tenantId, tenantId), eq(products.id, id)))
      .returning();

    return updated ?? null;
  }

  public async archive(tenantId: string, id: string): Promise<boolean> {
    const db = getDatabase();
    const [archived] = await db
      .update(products)
      .set({ active: false, updatedAt: new Date() })
      .where(and(eq(products.tenantId, tenantId), eq(products.id, id)))
      .returning();

    return Boolean(archived);
  }

  public async bulkInsert(items: NewProduct[]): Promise<Product[]> {
    if (items.length === 0) return [];
    const db = getDatabase();
    return db.insert(products).values(items).returning();
  }
}
