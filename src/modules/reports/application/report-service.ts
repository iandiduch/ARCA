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

export class ReportService {
  private reportRepo = new ReportRepository();

  public async getSalesReport(
    tenantId: string,
    filters: ReportFilterOptions
  ): Promise<SalesReportResult> {
    const summary = await this.reportRepo.getSalesSummary(tenantId, filters);
    const byVoucherRaw = await this.reportRepo.getSalesByVoucherType(tenantId, filters);
    const byVatRaw = await this.reportRepo.getVatSubtotalsSummary(tenantId, filters);

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
      'IVA 21%',
      'IVA 10.5%',
      'IVA 27%',
      'Otros Tributos',
      'Total Facturado',
      'CAE',
      'Vto. CAE'
    ];

    const rows: string[] = [headers.join(';')];

    for (const inv of ledgerInvoices) {
      const dateStr = new Date(inv.createdAt).toLocaleDateString('es-AR', {
        timeZone: 'America/Argentina/Buenos_Aires'
      });
      const voucherName = this.getVoucherDescription(inv.voucherType, inv.voucherLetter);
      const ptoVta = String(inv.pointOfSaleNumber).padStart(5, '0');
      const nro = String(inv.voucherNumber ?? 0).padStart(8, '0');
      const docTipo = inv.customerDocType === 80 ? 'CUIT' : inv.customerDocType === 96 ? 'DNI' : 'CF';
      const docNro = inv.customerDocNumber;
      const cliente = `"${inv.customerName.replace(/"/g, '""')}"`;
      const condicion = this.getFiscalConditionName(inv.customerTaxCondition);

      const neto = Number(inv.netTaxedAmount).toFixed(2);
      const noGravado = Number(inv.netUntaxedAmount).toFixed(2);
      const exento = Number(inv.exemptAmount).toFixed(2);

      // Desglose de IVA por tasa
      const iva21Obj = inv.vatBreakdown.find((v) => v.vatAfipCode === 5);
      const iva105Obj = inv.vatBreakdown.find((v) => v.vatAfipCode === 4);
      const iva27Obj = inv.vatBreakdown.find((v) => v.vatAfipCode === 6);

      const iva21 = iva21Obj ? Number(iva21Obj.vatAmount).toFixed(2) : '0.00';
      const iva105 = iva105Obj ? Number(iva105Obj.vatAmount).toFixed(2) : '0.00';
      const iva27 = iva27Obj ? Number(iva27Obj.vatAmount).toFixed(2) : '0.00';
      const otrosTrib = Number(inv.specialTaxesAmount).toFixed(2);
      const total = Number(inv.totalAmount).toFixed(2);
      const cae = inv.cae ?? '';
      const vtoCae = inv.caeExpiresAt
        ? new Date(inv.caeExpiresAt).toLocaleDateString('es-AR', { timeZone: 'UTC' })
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
          iva21,
          iva105,
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
