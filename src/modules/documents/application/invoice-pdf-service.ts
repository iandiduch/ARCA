import PDFDocument from 'pdfkit';
import type { FullInvoice } from '../../invoices/infrastructure/invoice-repository.js';
import type { FiscalIdentity } from '../../../infrastructure/database/schema/fiscal-identities.js';
import { formatCuit } from '../../../core/fiscal/cuit-validator.js';
import { QrService } from './qr-service.js';

export class InvoicePdfService {
  /**
   * Genera el documento PDF reglamentario de la factura conforme al estándar de ARCA
   */
  public static async generatePdf(
    invoice: FullInvoice,
    identity: FiscalIdentity
  ): Promise<Buffer> {
    return new Promise(async (resolve, reject) => {
      try {
        const doc = new PDFDocument({
          size: 'A4',
          margin: 30,
          info: {
            Title: `Comprobante ${invoice.voucherLetter} ${invoice.pointOfSaleNumber}-${invoice.voucherNumber ?? 'DRAFT'}`,
            Author: identity.businessName,
            Subject: 'Factura Electrónica ARCA'
          }
        });

        const buffers: Buffer[] = [];
        doc.on('data', (chunk) => buffers.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(buffers)));
        doc.on('error', (err) => reject(err));

        const isDraft = invoice.status === 'DRAFT';
        const ptoVta = String(invoice.pointOfSaleNumber).padStart(5, '0');
        const nroComp = invoice.voucherNumber ? String(invoice.voucherNumber).padStart(8, '0') : 'BORRADOR';
        const dateFormatted = new Date(invoice.createdAt).toLocaleDateString('es-AR', {
          timeZone: 'America/Argentina/Buenos_Aires'
        });

        const voucherTypeTitle = this.getVoucherTitle(invoice.voucherType, invoice.voucherLetter);
        const afipCodeStr = `COD. ${String(invoice.voucherType).padStart(2, '0')}`;

        // 1. Marca de agua si es Borrador
        if (isDraft) {
          doc.save();
          doc.rotate(-45, { origin: [297, 420] });
          doc.fontSize(38);
          doc.fillColor('#ff0000', 0.15);
          doc.text('DOCUMENTO NO VÁLIDO COMO FACTURA', 50, 400, { align: 'center', width: 500 });
          doc.restore();
        }

        // ==========================================
        // 2. ENCABEZADO FISCAL (Recuadro superior)
        // ==========================================
        const headerY = 30;
        const headerHeight = 132;
        doc.rect(30, headerY, 535, headerHeight).lineWidth(1).stroke('#333333');

        // Designación de copia: un comprobante digital siempre es el ORIGINAL
        doc.font('Helvetica-Bold').fontSize(9).fillColor('#333333');
        doc.text('ORIGINAL', 30, 16, { width: 535, align: 'center' });

        // Letra central del comprobante ('A', 'B', 'C', 'M')
        const letterBoxWidth = 36;
        const letterBoxHeight = 36;
        const letterBoxX = 297 - letterBoxWidth / 2;
        doc.rect(letterBoxX, headerY, letterBoxWidth, letterBoxHeight).fillAndStroke('#ffffff', '#333333');
        doc.fillColor('#000000').fontSize(22).font('Helvetica-Bold');
        doc.text(invoice.voucherLetter, letterBoxX, headerY + 4, { width: letterBoxWidth, align: 'center' });
        doc.fontSize(7).font('Helvetica');
        doc.text(afipCodeStr, letterBoxX, headerY + 26, { width: letterBoxWidth, align: 'center' });

        // Línea divisoria central
        doc.moveTo(297, headerY + letterBoxHeight).lineTo(297, headerY + headerHeight).stroke('#333333');

        // Columna Izquierda: Emisor
        const taxConditionLabels: Record<string, string> = {
          RESPONSABLE_INSCRIPTO: 'IVA Responsable Inscripto',
          RESPONSABLE_MONOTRIBUTO: 'Responsable Monotributo',
          EXENTO: 'IVA Sujeto Exento',
          CONSUMIDOR_FINAL: 'Consumidor Final',
          NO_RESPONSABLE: 'No Responsable'
        };
        const emisorTaxCond = (identity.taxCondition && taxConditionLabels[identity.taxCondition])
          ? taxConditionLabels[identity.taxCondition]
          : (identity.taxCondition || 'IVA Responsable Inscripto');

        // Nombre de fantasía como título destacado (con fallback a la razón social)
        const emisorTitle = (identity.fantasyName?.trim() || identity.businessName).toUpperCase();
        doc.font('Helvetica-Bold').fontSize(13).fillColor('#111111');
        doc.text(emisorTitle, 40, headerY + 12, { width: 240 });

        doc.font('Helvetica').fontSize(8.5).fillColor('#444444');
        doc.text(`Razón Social: ${identity.businessName}`, 40, headerY + 34, { width: 245 });
        doc.text(`Domicilio Comercial: ${identity.commercialAddress?.trim() || '-'}`, 40, headerY + 48, { width: 245 });
        doc.text(`Condición frente al IVA: ${emisorTaxCond}`, 40, headerY + 62, { width: 245 });
        doc.text('Punto de Emisión: Casa Central', 40, headerY + 76, { width: 245 });
        if (identity.environment === 'homologation') {
          doc.font('Helvetica-Oblique').fontSize(8).fillColor('#c0392b');
          doc.text('Entorno: Homologación (Sin validez fiscal)', 40, headerY + 92);
        }

        // Columna Derecha: Comprobante y Datos Fiscales
        doc.font('Helvetica-Bold').fontSize(14).fillColor('#111111');
        doc.text(voucherTypeTitle, 315, headerY + 15, { width: 240 });
        doc.font('Helvetica-Bold').fontSize(10).fillColor('#222222');
        doc.text(`Punto de Venta: ${ptoVta}   Comp. Nro: ${nroComp}`, 315, headerY + 35);
        doc.font('Helvetica').fontSize(9).fillColor('#333333');
        doc.text(`Fecha de Emisión: ${dateFormatted}`, 315, headerY + 52);
        doc.text(`CUIT: ${formatCuit(identity.cuit)}`, 315, headerY + 67);
        doc.text(`Ingresos Brutos: ${identity.grossIncomeNumber || identity.cuit}`, 315, headerY + 82);
        doc.text(`Inicio de Actividades: ${identity.activityStartDate || '01/01/2020'}`, 315, headerY + 97);

        // ==========================================
        // 3. PERIODO FACTURADO Y VENCIMIENTO DE PAGO
        // ==========================================
        // En un POS cobramos en el momento por algo tangible, así que por defecto
        // las tres fechas coinciden con la fecha de emisión del comprobante.
        const fmtPeriodDate = (d: Date | string | null | undefined): string =>
          d
            ? new Date(d).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })
            : dateFormatted;
        const issueRef = invoice.issueDate ?? invoice.createdAt;
        const periodFrom = fmtPeriodDate(invoice.serviceDateFrom ?? issueRef);
        const periodTo = fmtPeriodDate(invoice.serviceDateTo ?? issueRef);
        const paymentDue = fmtPeriodDate(invoice.paymentDueDate ?? issueRef);

        const periodY = headerY + headerHeight + 8;
        const periodHeight = 22;
        doc.rect(30, periodY, 535, periodHeight).lineWidth(0.8).stroke('#666666');
        doc.font('Helvetica-Bold').fontSize(8).fillColor('#222222');
        doc.text(`Período Facturado Desde: ${periodFrom}`, 38, periodY + 7, { width: 195 });
        doc.text(`Hasta: ${periodTo}`, 238, periodY + 7, { width: 100 });
        doc.text(`Fecha de Vto. para el Pago: ${paymentDue}`, 345, periodY + 7, { width: 215 });

        // ==========================================
        // 4. DATOS DEL CLIENTE / RECEPTOR
        // ==========================================
        const clientY = periodY + periodHeight + 8;
        const clientHeight = 60;
        doc.rect(30, clientY, 535, clientHeight).lineWidth(0.8).stroke('#666666');

        doc.font('Helvetica-Bold').fontSize(9).fillColor('#222222');
        const docLabel = invoice.customerDocType === 80 ? 'CUIT' : invoice.customerDocType === 96 ? 'DNI' : 'Doc';
        doc.text(`${docLabel}:`, 40, clientY + 10);
        doc.font('Helvetica').text(invoice.customerDocNumber, 80, clientY + 10);

        doc.font('Helvetica-Bold').text('Razón Social:', 240, clientY + 10);
        doc.font('Helvetica').text(invoice.customerName, 315, clientY + 10, { width: 240 });

        doc.font('Helvetica-Bold').text('Condición IVA:', 40, clientY + 30);
        doc.font('Helvetica').text(this.getFiscalConditionName(invoice.customerTaxCondition), 115, clientY + 30);

        doc.font('Helvetica-Bold').text('Domicilio:', 240, clientY + 30);
        doc.font('Helvetica').text(invoice.customerAddress || 'Ciudad Autónoma de Buenos Aires', 295, clientY + 30, { width: 260 });

        // ==========================================
        // 5. TABLA DE ÍTEMS Y PRODUCTOS
        // ==========================================
        const tableY = clientY + clientHeight + 10;
        doc.rect(30, tableY, 535, 20).fill('#e9ecef');
        doc.rect(30, tableY, 535, 20).stroke('#aaaaaa');

        doc.font('Helvetica-Bold').fontSize(8).fillColor('#212529');
        doc.text('Descripción', 35, tableY + 6, { width: 230 });
        doc.text('Cant.', 270, tableY + 6, { width: 45, align: 'right' });
        doc.text('Precio Unit.', 320, tableY + 6, { width: 60, align: 'right' });
        doc.text('Desc.', 385, tableY + 6, { width: 45, align: 'right' });
        doc.text('IVA %', 435, tableY + 6, { width: 40, align: 'right' });
        doc.text('Subtotal', 480, tableY + 6, { width: 80, align: 'right' });

        let rowY = tableY + 22;
        doc.font('Helvetica').fontSize(8).fillColor('#333333');

        for (const item of invoice.items) {
          doc.text(item.description, 35, rowY, { width: 230 });
          doc.text(Number(item.quantity).toFixed(2), 270, rowY, { width: 45, align: 'right' });
          doc.text(`$${Number(item.unitPrice).toFixed(2)}`, 320, rowY, { width: 60, align: 'right' });
          doc.text(Number(item.discount) > 0 ? `$${Number(item.discount).toFixed(2)}` : '-', 385, rowY, { width: 45, align: 'right' });
          doc.text(`${Number(item.vatRate).toFixed(1)}%`, 435, rowY, { width: 40, align: 'right' });
          doc.text(`$${Number(item.totalSubtotal).toFixed(2)}`, 480, rowY, { width: 80, align: 'right' });

          rowY += 16;
          if (rowY > 640) break; // Límite de página A4
        }

        // ==========================================
        // 6. TOTALES Y DESGLOSE IMPOSITIVO
        // ==========================================
        const totalsY = 660;
        doc.rect(30, totalsY, 535, 50).lineWidth(0.8).stroke('#888888');

        if (invoice.voucherLetter === 'A') {
          // Factura A: IVA discriminado
          doc.font('Helvetica-Bold').fontSize(8).fillColor('#333333');
          doc.text(`Neto Gravado: $${Number(invoice.netTaxedAmount).toFixed(2)}`, 40, totalsY + 12);
          doc.text(`IVA Total: $${Number(invoice.vatAmount).toFixed(2)}`, 180, totalsY + 12);
          doc.text(`No Gravado: $${Number(invoice.netUntaxedAmount).toFixed(2)}`, 40, totalsY + 30);
          doc.text(`Exento: $${Number(invoice.exemptAmount).toFixed(2)}`, 180, totalsY + 30);
        } else {
          doc.font('Helvetica').fontSize(9).fillColor('#555555');
          doc.text('Comprobante emitido a Consumidor Final / Monotributo.', 40, totalsY + 20);
        }

        // Total destacado
        doc.rect(370, totalsY + 5, 190, 40).fill('#f8f9fa');
        doc.rect(370, totalsY + 5, 190, 40).stroke('#222222');
        doc.font('Helvetica-Bold').fontSize(11).fillColor('#000000');
        doc.text('TOTAL:', 380, totalsY + 18);
        doc.fontSize(14);
        doc.text(`$ ${Number(invoice.totalAmount).toFixed(2)}`, 440, totalsY + 16, { width: 110, align: 'right' });

        // ==========================================
        // 7. PIE FISCAL (QR, CAE Y VENCIMIENTO)
        // ==========================================
        const footerY = 720;
        doc.rect(30, footerY, 535, 85).lineWidth(1).stroke('#333333');

        // Código QR oficial RG 5003
        if (invoice.qrData) {
          try {
            const qrPngBuffer = await QrService.generatePngBuffer(invoice.qrData, 180);
            doc.image(qrPngBuffer, 40, footerY + 8, { width: 70, height: 70 });
          } catch {
            doc.text('[QR Fiscal]', 45, footerY + 35);
          }
        }

        // Información de CAE y Leyenda AFIP
        doc.font('Helvetica-Bold').fontSize(12).fillColor('#111111');
        doc.text('ARCA', 125, footerY + 14);
        doc.font('Helvetica').fontSize(8).fillColor('#555555');
        doc.text('Agencia de Recaudación y Control Aduanero', 165, footerY + 17);

        if (invoice.cae) {
          doc.font('Helvetica-Bold').fontSize(10).fillColor('#000000');
          doc.text(`CAE N°: ${invoice.cae}`, 350, footerY + 25);
          const vtoStr = invoice.caeExpiresAt
            ? new Date(invoice.caeExpiresAt).toLocaleDateString('es-AR', { timeZone: 'UTC' })
            : '-';
          doc.text(`Fecha de Vto. de CAE: ${vtoStr}`, 350, footerY + 45);
        } else {
          doc.font('Helvetica-Bold').fontSize(10).fillColor('#d32f2f');
          doc.text('DOCUMENTO NO FISCAL - SIN CAE', 350, footerY + 35);
        }

        doc.font('Helvetica-Oblique').fontSize(7).fillColor('#777777');
        doc.text('Comprobante emitido mediante el Sistema Oficial de Facturación Electrónica RG 1415 / RG 5003.', 125, footerY + 65, { width: 430 });

        doc.end();
      } catch (err) {
        reject(err);
      }
    });
  }

  private static getVoucherTitle(voucherType: number, voucherLetter: string): string {
    switch (voucherType) {
      case 1:
      case 6:
      case 11:
      case 51:
        return `FACTURA "${voucherLetter}"`;
      case 2:
      case 7:
      case 12:
      case 52:
        return `NOTA DE DÉBITO "${voucherLetter}"`;
      case 3:
      case 8:
      case 13:
      case 53:
        return `NOTA DE CRÉDITO "${voucherLetter}"`;
      default:
        return `COMPROBANTE "${voucherLetter}"`;
    }
  }

  private static getFiscalConditionName(conditionCode?: number | null | undefined): string {
    switch (conditionCode) {
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
