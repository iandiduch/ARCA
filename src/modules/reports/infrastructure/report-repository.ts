import { eq, and, gte, lte, sql, desc, asc } from 'drizzle-orm';
import { getDatabase } from '../../../infrastructure/database/connection.js';
import { invoices, type Invoice } from '../../../infrastructure/database/schema/invoices.js';
import { invoiceVatSubtotals } from '../../../infrastructure/database/schema/invoice-vat-subtotals.js';

export interface ReportFilterOptions {
  fromDate?: Date | undefined;
  toDate?: Date | undefined;
  fiscalIdentityId?: string | undefined;
  pointOfSaleNumber?: number | undefined;
  voucherType?: number | undefined;
}

export class ReportRepository {
  public async getSalesSummary(tenantId: string, filters: ReportFilterOptions) {
    const db = getDatabase();
    const conditions = [eq(invoices.tenantId, tenantId)];

    if (filters.fiscalIdentityId) {
      conditions.push(eq(invoices.fiscalIdentityId, filters.fiscalIdentityId));
    }
    if (filters.pointOfSaleNumber !== undefined) {
      conditions.push(eq(invoices.pointOfSaleNumber, filters.pointOfSaleNumber));
    }
    if (filters.voucherType !== undefined) {
      conditions.push(eq(invoices.voucherType, filters.voucherType));
    }
    if (filters.fromDate) {
      conditions.push(gte(invoices.createdAt, filters.fromDate));
    }
    if (filters.toDate) {
      conditions.push(lte(invoices.createdAt, filters.toDate));
    }

    const whereClause = and(...conditions);

    // Totales agregados solo de comprobantes autorizados
    const [authorizedTotals] = await db
      .select({
        totalAmount: sql<string>`coalesce(sum(case when ${invoices.status} = 'AUTHORIZED' then ${invoices.totalAmount} else 0 end), 0)`,
        netTaxedAmount: sql<string>`coalesce(sum(case when ${invoices.status} = 'AUTHORIZED' then ${invoices.netTaxedAmount} else 0 end), 0)`,
        vatAmount: sql<string>`coalesce(sum(case when ${invoices.status} = 'AUTHORIZED' then ${invoices.vatAmount} else 0 end), 0)`,
        netUntaxedAmount: sql<string>`coalesce(sum(case when ${invoices.status} = 'AUTHORIZED' then ${invoices.netUntaxedAmount} else 0 end), 0)`,
        exemptAmount: sql<string>`coalesce(sum(case when ${invoices.status} = 'AUTHORIZED' then ${invoices.exemptAmount} else 0 end), 0)`,
        countAuthorized: sql<number>`cast(count(case when ${invoices.status} = 'AUTHORIZED' then 1 end) as integer)`,
        countDraft: sql<number>`cast(count(case when ${invoices.status} = 'DRAFT' then 1 end) as integer)`,
        countRejected: sql<number>`cast(count(case when ${invoices.status} = 'REJECTED' then 1 end) as integer)`,
        countPending: sql<number>`cast(count(case when ${invoices.status} = 'PENDING_RECONCILIATION' then 1 end) as integer)`
      })
      .from(invoices)
      .where(whereClause);

    return {
      totalInvoiced: Number(authorizedTotals?.totalAmount ?? 0),
      totalNet: Number(authorizedTotals?.netTaxedAmount ?? 0),
      totalVat: Number(authorizedTotals?.vatAmount ?? 0),
      totalUntaxed: Number(authorizedTotals?.netUntaxedAmount ?? 0),
      totalExempt: Number(authorizedTotals?.exemptAmount ?? 0),
      counts: {
        authorized: authorizedTotals?.countAuthorized ?? 0,
        draft: authorizedTotals?.countDraft ?? 0,
        rejected: authorizedTotals?.countRejected ?? 0,
        pendingReconciliation: authorizedTotals?.countPending ?? 0
      }
    };
  }

  public async getSalesByVoucherType(tenantId: string, filters: ReportFilterOptions) {
    const db = getDatabase();
    const conditions = [
      eq(invoices.tenantId, tenantId),
      eq(invoices.status, 'AUTHORIZED')
    ];

    if (filters.fiscalIdentityId) conditions.push(eq(invoices.fiscalIdentityId, filters.fiscalIdentityId));
    if (filters.pointOfSaleNumber !== undefined) conditions.push(eq(invoices.pointOfSaleNumber, filters.pointOfSaleNumber));
    if (filters.fromDate) conditions.push(gte(invoices.createdAt, filters.fromDate));
    if (filters.toDate) conditions.push(lte(invoices.createdAt, filters.toDate));

    return db
      .select({
        voucherType: invoices.voucherType,
        voucherLetter: invoices.voucherLetter,
        count: sql<number>`cast(count(*) as integer)`,
        total: sql<string>`coalesce(sum(${invoices.totalAmount}), 0)`
      })
      .from(invoices)
      .where(and(...conditions))
      .groupBy(invoices.voucherType, invoices.voucherLetter);
  }

  public async getVatSubtotalsSummary(tenantId: string, filters: ReportFilterOptions) {
    const db = getDatabase();
    const conditions = [
      eq(invoices.tenantId, tenantId),
      eq(invoices.status, 'AUTHORIZED')
    ];

    if (filters.fiscalIdentityId) conditions.push(eq(invoices.fiscalIdentityId, filters.fiscalIdentityId));
    if (filters.pointOfSaleNumber !== undefined) conditions.push(eq(invoices.pointOfSaleNumber, filters.pointOfSaleNumber));
    if (filters.fromDate) conditions.push(gte(invoices.createdAt, filters.fromDate));
    if (filters.toDate) conditions.push(lte(invoices.createdAt, filters.toDate));

    return db
      .select({
        vatAfipCode: invoiceVatSubtotals.vatAfipCode,
        vatRate: invoiceVatSubtotals.vatRate,
        baseAmount: sql<string>`coalesce(sum(${invoiceVatSubtotals.baseAmount}), 0)`,
        vatAmount: sql<string>`coalesce(sum(${invoiceVatSubtotals.vatAmount}), 0)`
      })
      .from(invoiceVatSubtotals)
      .innerJoin(invoices, eq(invoiceVatSubtotals.invoiceId, invoices.id))
      .where(and(...conditions))
      .groupBy(invoiceVatSubtotals.vatAfipCode, invoiceVatSubtotals.vatRate);
  }

  public async getVatSalesLedgerInvoices(tenantId: string, filters: ReportFilterOptions): Promise<Array<Invoice & { vatBreakdown: Array<{ vatAfipCode: number; vatRate: string; baseAmount: string; vatAmount: string }> }>> {
    const db = getDatabase();
    const conditions = [
      eq(invoices.tenantId, tenantId),
      eq(invoices.status, 'AUTHORIZED')
    ];

    if (filters.fiscalIdentityId) conditions.push(eq(invoices.fiscalIdentityId, filters.fiscalIdentityId));
    if (filters.pointOfSaleNumber !== undefined) conditions.push(eq(invoices.pointOfSaleNumber, filters.pointOfSaleNumber));
    if (filters.fromDate) conditions.push(gte(invoices.createdAt, filters.fromDate));
    if (filters.toDate) conditions.push(lte(invoices.createdAt, filters.toDate));

    const invoiceRows = await db
      .select()
      .from(invoices)
      .where(and(...conditions))
      .orderBy(asc(invoices.pointOfSaleNumber), asc(invoices.voucherNumber));

    const results = [];
    for (const inv of invoiceRows) {
      const vats = await db
        .select({
          vatAfipCode: invoiceVatSubtotals.vatAfipCode,
          vatRate: invoiceVatSubtotals.vatRate,
          baseAmount: invoiceVatSubtotals.baseAmount,
          vatAmount: invoiceVatSubtotals.vatAmount
        })
        .from(invoiceVatSubtotals)
        .where(eq(invoiceVatSubtotals.invoiceId, inv.id));

      results.push({
        ...inv,
        vatBreakdown: vats
      });
    }

    return results;
  }
}
