import { eq, and, or, ilike } from 'drizzle-orm';
import { getDatabase } from '../../../infrastructure/database/connection.js';
import { customers, type Customer, type NewCustomer } from '../../../infrastructure/database/schema/customers.js';

export interface ListCustomersOptions {
  search?: string | undefined;
  activeOnly?: boolean | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export class CustomerRepository {
  public async create(data: NewCustomer): Promise<Customer> {
    const db = getDatabase();
    const [created] = await db.insert(customers).values(data).returning();
    if (!created) {
      throw new Error('Fallo al registrar cliente');
    }
    return created;
  }

  public async findById(tenantId: string, id: string): Promise<Customer | null> {
    const db = getDatabase();
    const [found] = await db
      .select()
      .from(customers)
      .where(and(eq(customers.tenantId, tenantId), eq(customers.id, id)))
      .limit(1);

    return found ?? null;
  }

  public async findByDocument(
    tenantId: string,
    documentType: string,
    documentNumber: string
  ): Promise<Customer | null> {
    const db = getDatabase();
    const [found] = await db
      .select()
      .from(customers)
      .where(
        and(
          eq(customers.tenantId, tenantId),
          eq(customers.documentType, documentType),
          eq(customers.documentNumber, documentNumber)
        )
      )
      .limit(1);

    return found ?? null;
  }

  public async list(tenantId: string, options?: ListCustomersOptions): Promise<Customer[]> {
    const db = getDatabase();
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;

    const conditions = [eq(customers.tenantId, tenantId)];

    if (options?.activeOnly !== false) {
      conditions.push(eq(customers.active, true));
    }

    if (options?.search) {
      const q = `%${options.search}%`;
      conditions.push(
        or(
          ilike(customers.name, q),
          ilike(customers.documentNumber, q),
          ilike(customers.email, q)
        )!
      );
    }

    return db
      .select()
      .from(customers)
      .where(and(...conditions))
      .limit(limit)
      .offset(offset);
  }

  public async update(
    tenantId: string,
    id: string,
    data: Partial<Omit<NewCustomer, 'id' | 'tenantId' | 'createdAt'>>
  ): Promise<Customer | null> {
    const db = getDatabase();
    const [updated] = await db
      .update(customers)
      .set({
        ...data,
        updatedAt: new Date()
      })
      .where(and(eq(customers.tenantId, tenantId), eq(customers.id, id)))
      .returning();

    return updated ?? null;
  }

  public async archive(tenantId: string, id: string): Promise<boolean> {
    const db = getDatabase();
    const [archived] = await db
      .update(customers)
      .set({ active: false, updatedAt: new Date() })
      .where(and(eq(customers.tenantId, tenantId), eq(customers.id, id)))
      .returning();

    return Boolean(archived);
  }
}
