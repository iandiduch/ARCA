import { ReportRepository, type ReportFilterOptions } from '../infrastructure/report-repository.js';
import { getVoucherLetter } from '../../../core/fiscal/tax-catalogs.js';

export interface SalesReportResult {
  period: {
    fromDate?: string | undefined;
    toDate?: string | undefined;
  };
  summary: {
    totalInvoiced: number;
    totalNet: number;
    totalVat: number;
    totalUntaxed: number;
    totalExempt: number;
    counts: {
      authorized: number;
      draft: number;
      rejected: number;
      pendingReconciliation: number;
    };
  };
  byVoucherType: Array<{
    voucherType: number;
    voucherLetter: string;
    description: string;
    count: number;
    total: number;
  }>;
  byVatRate: Array<{
    vatAfipCode: number;
    vatRate: number;
    baseAmount: number;
    vatAmount: number;
  }>;
}

// Formateadores reutilizados: toLocaleDateString con opciones crea uno nuevo por llamada y, con decenas de miles
// de filas, bloquea el event loop varios segundos (todas las emisiones del proceso quedan esperando)
const AR_DATE = new Intl.DateTimeFormat('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
const UTC_DATE = new Intl.DateTimeFormat('es-AR', { timeZone: 'UTC' });

function sanitizeCsvCell(val: string | null | undefined): string {
  if (!val) return '""';
  let str = String(val);
  if (/^[=+\-@\t\r]/.test(str)) {
    str = "'" + str;
  }
  return `"${str.replace(/"/g, '""')}"`;
}

export class ReportService {
  private reportRepo = new ReportRepository();

  public async getSalesReport(
    tenantId: string,
    filters: ReportFilterOptions
  ): Promise<SalesReportResult> {
    // M10: Rango de fecha por defecto de 90 días si no se envía fromDate para evitar agregaciones históricas ilimitadas
    const effectiveFilters: ReportFilterOptions = {
      ...filters,
      fromDate: filters.fromDate ?? new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
    };

    const summary = await this.reportRepo.getSalesSummary(tenantId, effectiveFilters);
    const byVoucherRaw = await this.reportRepo.getSalesByVoucherType(tenantId, effectiveFilters);
    const byVatRaw = await this.reportRepo.getVatSubtotalsSummary(tenantId, effectiveFilters);

    const byVoucherType = byVoucherRaw.map((v) => ({
      voucherType: v.voucherType,
      voucherLetter: v.voucherLetter,
      description: this.getVoucherDescription(v.voucherType, v.voucherLetter),
      count: v.count,
      total: Number(v.total)
    }));

    const byVatRate = byVatRaw.map((vat) => ({
      vatAfipCode: vat.vatAfipCode,
      vatRate: Number(vat.vatRate),
      baseAmount: Number(vat.baseAmount),
      vatAmount: Number(vat.vatAmount)
    }));

    return {
      period: {
        fromDate: filters.fromDate?.toISOString(),
        toDate: filters.toDate?.toISOString()
      },
      summary,
      byVoucherType,
      byVatRate
    };
  }

  /**
   * Genera el archivo CSV oficial del Libro IVA Ventas para exportación contable
   */
  public async getVatSalesLedgerCsv(
    tenantId: string,
    filters: ReportFilterOptions
  ): Promise<string> {
    const ledgerInvoices = await this.reportRepo.getVatSalesLedgerInvoices(tenantId, filters);

    const headers = [
      'Fecha',
      'Tipo Comprobante',
      'Pto. Venta',
      'Nro. Comprobante',
      'Doc. Tipo',
      'Doc. Nro',
      'Cliente / Razon Social',
      'Condicion IVA',
      'Neto Gravado',
      'No Gravado',
      'Exento',
      'IVA 0%',
      'IVA 2.5%',
      'IVA 5%',
      'IVA 10.5%',
      'IVA 21%',
      'IVA 27%',
      'Otros Tributos',
      'Total Facturado',
      'CAE',
      'Vto. CAE'
    ];

    const rows: string[] = [headers.join(';')];

    for (const inv of ledgerInvoices) {
      const dateStr = AR_DATE.format(new Date(inv.createdAt));
      const voucherName = this.getVoucherDescription(inv.voucherType, inv.voucherLetter);
      const ptoVta = String(inv.pointOfSaleNumber).padStart(5, '0');
      const nro = String(inv.voucherNumber ?? 0).padStart(8, '0');
      const docTipo = inv.customerDocType === 80 ? 'CUIT' : inv.customerDocType === 96 ? 'DNI' : 'CF';
      const docNro = inv.customerDocNumber;
      const cliente = sanitizeCsvCell(inv.customerName);
      const condicion = this.getFiscalConditionName(inv.customerTaxCondition);

      const neto = Number(inv.netTaxedAmount).toFixed(2);
      const noGravado = Number(inv.netUntaxedAmount).toFixed(2);
      const exento = Number(inv.exemptAmount).toFixed(2);

      // Desglose de IVA por tasa oficial (M1: catálogo completo de alícuotas ARCA)
      const iva0Obj = inv.vatBreakdown.find((v) => v.vatAfipCode === 3);
      const iva25Obj = inv.vatBreakdown.find((v) => v.vatAfipCode === 9);
      const iva5Obj = inv.vatBreakdown.find((v) => v.vatAfipCode === 8);
      const iva105Obj = inv.vatBreakdown.find((v) => v.vatAfipCode === 4);
      const iva21Obj = inv.vatBreakdown.find((v) => v.vatAfipCode === 5);
      const iva27Obj = inv.vatBreakdown.find((v) => v.vatAfipCode === 6);

      const iva0 = iva0Obj ? Number(iva0Obj.vatAmount).toFixed(2) : '0.00';
      const iva25 = iva25Obj ? Number(iva25Obj.vatAmount).toFixed(2) : '0.00';
      const iva5 = iva5Obj ? Number(iva5Obj.vatAmount).toFixed(2) : '0.00';
      const iva105 = iva105Obj ? Number(iva105Obj.vatAmount).toFixed(2) : '0.00';
      const iva21 = iva21Obj ? Number(iva21Obj.vatAmount).toFixed(2) : '0.00';
      const iva27 = iva27Obj ? Number(iva27Obj.vatAmount).toFixed(2) : '0.00';
      const otrosTrib = Number(inv.specialTaxesAmount).toFixed(2);
      const total = Number(inv.totalAmount).toFixed(2);
      const cae = inv.cae ?? '';
      const vtoCae = inv.caeExpiresAt
        ? UTC_DATE.format(new Date(inv.caeExpiresAt))
        : '';

      rows.push(
        [
          dateStr,
          voucherName,
          ptoVta,
          nro,
          docTipo,
          docNro,
          cliente,
          condicion,
          neto,
          noGravado,
          exento,
          iva0,
          iva25,
          iva5,
          iva105,
          iva21,
          iva27,
          otrosTrib,
          total,
          cae,
          vtoCae
        ].join(';')
      );
    }

    return rows.join('\r\n');
  }

  private getVoucherDescription(voucherType: number, voucherLetter: string): string {
    switch (voucherType) {
      case 1:
        return 'Factura A';
      case 2:
        return 'Nota de Débito A';
      case 3:
        return 'Nota de Crédito A';
      case 6:
        return 'Factura B';
      case 7:
        return 'Nota de Débito B';
      case 8:
        return 'Nota de Crédito B';
      case 11:
        return 'Factura C';
      case 12:
        return 'Nota de Débito C';
      case 13:
        return 'Nota de Crédito C';
      default:
        return `Comprobante ${voucherLetter} (${voucherType})`;
    }
  }

  private getFiscalConditionName(code?: number | null): string {
    switch (code) {
      case 1:
        return 'IVA Responsable Inscripto';
      case 4:
        return 'IVA Sujeto Exento';
      case 5:
        return 'Consumidor Final';
      case 6:
        return 'Responsable Monotributo';
      default:
        return 'Consumidor Final';
    }
  }
}
