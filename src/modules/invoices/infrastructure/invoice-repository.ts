import { eq, and, asc, desc, sql, gte, lte, inArray, isNotNull, ne } from 'drizzle-orm';
import { getDatabase } from '../../../infrastructure/database/connection.js';
import {
  invoices,
  type Invoice,
  type NewInvoice
} from '../../../infrastructure/database/schema/invoices.js';
import {
  invoiceItems,
  type InvoiceItem,
  type NewInvoiceItem
} from '../../../infrastructure/database/schema/invoice-items.js';
import {
  invoiceVatSubtotals,
  type InvoiceVatSubtotal,
  type NewInvoiceVatSubtotal
} from '../../../infrastructure/database/schema/invoice-vat-subtotals.js';
import {
  invoiceAssociatedVouchers,
  type InvoiceAssociatedVoucher,
  type NewInvoiceAssociatedVoucher
} from '../../../infrastructure/database/schema/invoice-associated-vouchers.js';

export interface FullInvoice extends Invoice {
  items: InvoiceItem[];
  vatSubtotals: InvoiceVatSubtotal[];
  associatedVouchers: InvoiceAssociatedVoucher[];
}

export interface InvoiceListFilters {
  fiscalIdentityId?: string | undefined;
  status?: string | undefined;
  voucherType?: number | undefined;
  pointOfSaleNumber?: number | undefined;
  fromDate?: Date | undefined;
  toDate?: Date | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export class InvoiceRepository {
  public async createWithDetails(
    invoiceData: NewInvoice,
    itemsData: Array<Omit<NewInvoiceItem, 'id' | 'invoiceId' | 'createdAt'>>,
    vatSubtotalsData: Array<Omit<NewInvoiceVatSubtotal, 'id' | 'invoiceId' | 'createdAt'>>,
    associatedVouchersData: Array<Omit<NewInvoiceAssociatedVoucher, 'id' | 'invoiceId' | 'createdAt'>> = []
  ): Promise<FullInvoice> {
    const db = getDatabase();

    return db.transaction(async (tx) => {
      const [createdInvoice] = await tx.insert(invoices).values(invoiceData).returning();
      if (!createdInvoice) throw new Error('Fallo al crear registro de factura');

      let savedItems: InvoiceItem[] = [];
      if (itemsData.length > 0) {
        savedItems = await tx
          .insert(invoiceItems)
          .values(itemsData.map((it) => ({ ...it, invoiceId: createdInvoice.id })))
          .returning();
      }

      let savedVatSubtotals: InvoiceVatSubtotal[] = [];
      if (vatSubtotalsData.length > 0) {
        savedVatSubtotals = await tx
          .insert(invoiceVatSubtotals)
          .values(vatSubtotalsData.map((v) => ({ ...v, invoiceId: createdInvoice.id })))
          .returning();
      }

      let savedAssociated: InvoiceAssociatedVoucher[] = [];
      if (associatedVouchersData.length > 0) {
        savedAssociated = await tx
          .insert(invoiceAssociatedVouchers)
          .values(associatedVouchersData.map((a) => ({ ...a, invoiceId: createdInvoice.id })))
          .returning();
      }

      return {
        ...createdInvoice,
        items: savedItems,
        vatSubtotals: savedVatSubtotals,
        associatedVouchers: savedAssociated
      };
    });
  }

  public async findById(tenantId: string, id: string): Promise<FullInvoice | null> {
    const db = getDatabase();

    const [foundInvoice] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenantId), eq(invoices.id, id)))
      .limit(1);

    if (!foundInvoice) return null;

    const items = await db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, id));
    const vatSubtotals = await db
      .select()
      .from(invoiceVatSubtotals)
      .where(eq(invoiceVatSubtotals.invoiceId, id));
    const associated = await db
      .select()
      .from(invoiceAssociatedVouchers)
      .where(eq(invoiceAssociatedVouchers.invoiceId, id));

    return {
      ...foundInvoice,
      items,
      vatSubtotals,
      associatedVouchers: associated
    };
  }

  public async update(
    tenantId: string,
    id: string,
    data: Partial<Omit<NewInvoice, 'id' | 'tenantId' | 'createdAt'>>
  ): Promise<Invoice | null> {
    const db = getDatabase();
    const [updated] = await db
      .update(invoices)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(invoices.tenantId, tenantId), eq(invoices.id, id)))
      .returning();

    return updated ?? null;
  }

  public async list(
    tenantId: string,
    filters: InvoiceListFilters = {}
  ): Promise<{ data: Invoice[]; total: number }> {
    const db = getDatabase();
    const conditions = [eq(invoices.tenantId, tenantId)];

    if (filters.fiscalIdentityId) {
      conditions.push(eq(invoices.fiscalIdentityId, filters.fiscalIdentityId));
    }
    if (filters.status) {
      conditions.push(eq(invoices.status, filters.status));
    }
    if (filters.voucherType !== undefined) {
      conditions.push(eq(invoices.voucherType, filters.voucherType));
    }
    if (filters.pointOfSaleNumber !== undefined) {
      conditions.push(eq(invoices.pointOfSaleNumber, filters.pointOfSaleNumber));
    }
    if (filters.fromDate) {
      conditions.push(gte(invoices.createdAt, filters.fromDate));
    }
    if (filters.toDate) {
      conditions.push(lte(invoices.createdAt, filters.toDate));
    }

    const whereClause = and(...conditions);

    const [countResult] = await db
      .select({ count: sql<number>`cast(count(*) as integer)` })
      .from(invoices)
      .where(whereClause);

    const limit = filters.limit ?? 50;
    const offset = filters.offset ?? 0;

    // L4: Excluir afipXmlRequest/afipXmlResponse del listado masivo para optimizar ancho de banda
    const data = await db
      .select({
        id: invoices.id,
        tenantId: invoices.tenantId,
        fiscalIdentityId: invoices.fiscalIdentityId,
        pointOfSaleNumber: invoices.pointOfSaleNumber,
        voucherType: invoices.voucherType,
        voucherLetter: invoices.voucherLetter,
        voucherNumber: invoices.voucherNumber,
        concept: invoices.concept,
        serviceDateFrom: invoices.serviceDateFrom,
        serviceDateTo: invoices.serviceDateTo,
        paymentDueDate: invoices.paymentDueDate,
        issueDate: invoices.issueDate,
        status: invoices.status,
        cae: invoices.cae,
        caeExpiresAt: invoices.caeExpiresAt,
        totalAmount: invoices.totalAmount,
        netTaxedAmount: invoices.netTaxedAmount,
        netUntaxedAmount: invoices.netUntaxedAmount,
        exemptAmount: invoices.exemptAmount,
        vatAmount: invoices.vatAmount,
        specialTaxesAmount: invoices.specialTaxesAmount,
        currency: invoices.currency,
        currencyRate: invoices.currencyRate,
        customerId: invoices.customerId,
        customerDocType: invoices.customerDocType,
        customerDocNumber: invoices.customerDocNumber,
        customerName: invoices.customerName,
        customerTaxCondition: invoices.customerTaxCondition,
        customerAddress: invoices.customerAddress,
        notes: invoices.notes,
        afipResult: invoices.afipResult,
        afipXmlRequest: sql<string | null>`null`.as('afip_xml_request'),
        afipXmlResponse: sql<string | null>`null`.as('afip_xml_response'),
        afipErrors: invoices.afipErrors,
        afipObservations: invoices.afipObservations,
        afipEvents: invoices.afipEvents,
        idempotencyKey: invoices.idempotencyKey,
        posSaleId: invoices.posSaleId,
        qrData: invoices.qrData,
        createdAt: invoices.createdAt,
        updatedAt: invoices.updatedAt
      })
      .from(invoices)
      .where(whereClause)
      .orderBy(desc(invoices.createdAt))
      .limit(limit)
      .offset(offset);

    return {
      data,
      total: countResult?.count ?? 0
    };
  }

  /**
   * Comprobantes con numeración asignada cuyo resultado en ARCA es desconocido (PENDING / PENDING_RECONCILIATION)
   * para una secuencia fiscal (identidad + punto de venta + tipo).
   */
  public async findUnresolvedInSequence(
    fiscalIdentityId: string,
    pointOfSaleNumber: number,
    voucherType: number,
    limit = 10
  ): Promise<Invoice[]> {
    const db = getDatabase();
    return db
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.fiscalIdentityId, fiscalIdentityId),
          eq(invoices.pointOfSaleNumber, pointOfSaleNumber),
          eq(invoices.voucherType, voucherType),
          inArray(invoices.status, ['PENDING', 'PENDING_RECONCILIATION']),
          isNotNull(invoices.voucherNumber)
        )
      )
      .orderBy(asc(invoices.voucherNumber))
      .limit(limit);
  }

  public async findLatestByIdempotencyKey(tenantId: string, idempotencyKey: string): Promise<Invoice | null> {
    const db = getDatabase();
    const [found] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenantId), eq(invoices.idempotencyKey, idempotencyKey)))
      .orderBy(desc(invoices.createdAt))
      .limit(1);
    return found ?? null;
  }

  public async findBySequenceNumber(
    fiscalIdentityId: string,
    pointOfSaleNumber: number,
    voucherType: number,
    voucherNumber: number
  ): Promise<Invoice | null> {
    const db = getDatabase();
    const [found] = await db
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.fiscalIdentityId, fiscalIdentityId),
          eq(invoices.pointOfSaleNumber, pointOfSaleNumber),
          eq(invoices.voucherType, voucherType),
          eq(invoices.voucherNumber, voucherNumber)
        )
      )
      .limit(1);
    return found ?? null;
  }

  public async findPendingReconciliation(tenantId: string): Promise<FullInvoice[]> {
    const db = getDatabase();
    const pendingList = await db
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.tenantId, tenantId),
          eq(invoices.status, 'PENDING_RECONCILIATION')
        )
      )
      .orderBy(desc(invoices.createdAt));

    const results: FullInvoice[] = [];
    for (const inv of pendingList) {
      const items = await db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, inv.id));
      const vatSubtotals = await db
        .select()
        .from(invoiceVatSubtotals)
        .where(eq(invoiceVatSubtotals.invoiceId, inv.id));
      const associated = await db
        .select()
        .from(invoiceAssociatedVouchers)
        .where(eq(invoiceAssociatedVouchers.invoiceId, inv.id));

      results.push({
        ...inv,
        items,
        vatSubtotals,
        associatedVouchers: associated
      });
    }

    return results;
  }

  /**
   * Obtiene la suma total de Notas de Crédito autorizadas o en curso vinculadas a un comprobante específico.
   * Incluye comprobantes en estado AUTHORIZED, PENDING y PENDING_RECONCILIATION para
   * evitar sobre-acreditaciones concurrentes o durante contingencias de red.
   */
  public async getTotalCreditedForVoucher(
    fiscalIdentityId: string,
    associatedVoucherType: number,
    pointOfSale: number,
    voucherNumber: number,
    excludeInvoiceId?: string
  ): Promise<number> {
    const db = getDatabase();
    const conditions = [
      eq(invoices.fiscalIdentityId, fiscalIdentityId),
      inArray(invoices.status, ['AUTHORIZED', 'PENDING', 'PENDING_RECONCILIATION']),
      inArray(invoices.voucherType, [3, 8, 13, 53]),
      eq(invoiceAssociatedVouchers.associatedVoucherType, associatedVoucherType),
      eq(invoiceAssociatedVouchers.pointOfSale, pointOfSale),
      eq(invoiceAssociatedVouchers.voucherNumber, voucherNumber)
    ];

    if (excludeInvoiceId) {
      conditions.push(ne(invoices.id, excludeInvoiceId));
    }

    const [result] = await db
      .select({
        total: sql<string>`coalesce(sum(${invoices.totalAmount}), 0)`
      })
      .from(invoiceAssociatedVouchers)
      .innerJoin(invoices, eq(invoices.id, invoiceAssociatedVouchers.invoiceId))
      .where(and(...conditions));

    return Number(result?.total ?? 0);
  }
}
