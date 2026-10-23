import type { FullInvoice } from '../../invoices/infrastructure/invoice-repository.js';
import type { FiscalIdentity } from '../../../infrastructure/database/schema/fiscal-identities.js';
import { formatCuit } from '../../../core/fiscal/cuit-validator.js';
import { QrService } from './qr-service.js';

export interface ThermalReceiptOptions {
  widthMm?: 80 | 58 | undefined;
  format?: 'text' | 'html' | undefined;
}

export class ThermalPrinterService {
  /**
   * Genera el comprobante listo para ticketeras térmicas en texto plano o HTML con QR incrustado
   */
  public static async generate(
    invoice: FullInvoice,
    identity: FiscalIdentity,
    options: ThermalReceiptOptions = {}
  ): Promise<{ content: string; contentType: string }> {
    const widthMm = options.widthMm ?? 80;
    const format = options.format ?? 'text';

    if (format === 'html') {
      const qrDataUrl = invoice.qrData ? await QrService.generateDataUrl(invoice.qrData, 140) : undefined;
      const html = this.buildHtmlReceipt(invoice, identity, widthMm, qrDataUrl);
      return { content: html, contentType: 'text/html; charset=utf-8' };
    }

    const text = this.buildPlainTextReceipt(invoice, identity, widthMm);
    return { content: text, contentType: 'text/plain; charset=utf-8' };
  }

  private static buildPlainTextReceipt(
    invoice: FullInvoice,
    identity: FiscalIdentity,
    widthMm: number
  ): string {
    const cols = widthMm === 58 ? 32 : 48;
    const sep = '='.repeat(cols);
    const dash = '-'.repeat(cols);

    const padCenter = (str: string) => {
      const trimmed = str.slice(0, cols);
      const remaining = cols - trimmed.length;
      const left = Math.floor(remaining / 2);
      return ' '.repeat(left) + trimmed;
    };

    const padRow = (left: string, right: string) => {
      const space = cols - left.length - right.length;
      if (space <= 0) return `${left} ${right}`.slice(0, cols);
      return left + ' '.repeat(space) + right;
    };

    const lines: string[] = [];

    // Encabezado
    lines.push(sep);
    lines.push(padCenter(identity.businessName.toUpperCase()));
    lines.push(padCenter(`CUIT: ${formatCuit(identity.cuit)}`));
    lines.push(padCenter(`P.V. ${String(invoice.pointOfSaleNumber).padStart(5, '0')} - Comp. ${invoice.voucherNumber ? String(invoice.voucherNumber).padStart(8, '0') : 'DRAFT'}`));
    lines.push(sep);

    if (invoice.status === 'DRAFT') {
      lines.push(padCenter('*** DOCUMENTO NO VALIDO COMO FACTURA ***'));
      lines.push(dash);
    }

    // Datos del comprobante
    const dateStr = new Date(invoice.createdAt).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
    lines.push(padRow(`COMPROBANTE ${invoice.voucherLetter}`, dateStr));
    lines.push(padRow('CLIENTE:', invoice.customerName.slice(0, cols - 9)));
    if (invoice.customerDocNumber && invoice.customerDocNumber !== '0') {
      const docLabel = invoice.customerDocType === 80 ? 'CUIT' : invoice.customerDocType === 96 ? 'DNI' : 'DOC';
      lines.push(padRow(`${docLabel}:`, invoice.customerDocNumber));
    }
    lines.push(dash);

    // Ítems
    lines.push(padRow('DESCRIPCION / CANT.', 'SUBTOTAL'));
    lines.push(dash);

    for (const item of invoice.items) {
      const qty = Number(item.quantity);
      const price = Number(item.unitPrice).toFixed(2);
      const total = Number(item.totalSubtotal).toFixed(2);
      lines.push(item.description.slice(0, cols));
      lines.push(padRow(`  ${qty} x $${price}`, `$${total}`));
    }

    lines.push(dash);
    lines.push(padRow('TOTAL:', `$${Number(invoice.totalAmount).toFixed(2)}`));
    lines.push(sep);

    // Pie fiscal
    if (invoice.cae) {
      lines.push(padRow('CAE N°:', invoice.cae));
      const vto = invoice.caeExpiresAt
        ? new Date(invoice.caeExpiresAt).toLocaleDateString('es-AR', { timeZone: 'UTC' })
        : '-';
      lines.push(padRow('VTO. CAE:', vto));
      lines.push(padCenter('Comprobante Autorizado por ARCA (AFIP)'));
      if (invoice.qrData) {
        lines.push(dash);
        lines.push(padCenter('Verificación QR Oficial:'));
        lines.push(invoice.qrData);
      }
    } else {
      lines.push(padCenter('*** NO VALIDO COMO FACTURA ***'));
    }

    lines.push(sep);
    return lines.join('\n');
  }

  private static buildHtmlReceipt(
    invoice: FullInvoice,
    identity: FiscalIdentity,
    widthMm: number,
    qrDataUrl?: string
  ): string {
    const widthPx = widthMm === 58 ? '260px' : '340px';
    const isDraft = invoice.status === 'DRAFT';
    const dateStr = new Date(invoice.createdAt).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
    const ptoVtaFormatted = String(invoice.pointOfSaleNumber).padStart(5, '0');
    const nroFormatted = invoice.voucherNumber ? String(invoice.voucherNumber).padStart(8, '0') : 'BORRADOR';

    return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <title>Comprobante ${invoice.voucherLetter} ${ptoVtaFormatted}-${nroFormatted}</title>
  <style>
    body {
      font-family: 'Courier New', Courier, monospace;
      font-size: 12px;
      margin: 0;
      padding: 10px;
      background: #f4f4f4;
      display: flex;
      justify-content: center;
    }
    .ticket {
      width: ${widthPx};
      background: #fff;
      padding: 14px;
      border: 1px dashed #ccc;
      box-shadow: 0 2px 6px rgba(0,0,0,0.1);
    }
    .text-center { text-align: center; }
    .text-right { text-align: right; }
    .bold { font-weight: bold; }
    .divider { border-top: 1px dashed #000; margin: 8px 0; }
    .double-divider { border-top: 2px solid #000; margin: 8px 0; }
    .row { display: flex; justify-content: space-between; margin-bottom: 3px; }
    .watermark {
      color: #d32f2f;
      border: 2px solid #d32f2f;
      padding: 4px;
      text-align: center;
      font-weight: bold;
      margin: 6px 0;
    }
    .qr-container { text-align: center; margin-top: 10px; }
    .qr-container img { width: 120px; height: 120px; }
    @media print {
      body { background: transparent; padding: 0; }
      .ticket { border: none; box-shadow: none; width: 100%; }
    }
  </style>
</head>
<body>
  <div class="ticket">
    <div class="double-divider"></div>
    <div class="text-center bold" style="font-size: 14px;">${identity.businessName.toUpperCase()}</div>
    <div class="text-center">CUIT: ${formatCuit(identity.cuit)}</div>
    <div class="text-center">Pto. Venta: ${ptoVtaFormatted} - Comp: ${nroFormatted}</div>
    <div class="double-divider"></div>

    ${isDraft ? '<div class="watermark">DOCUMENTO NO VÁLIDO COMO FACTURA</div>' : ''}

    <div class="row">
      <span class="bold">FACTURA "${invoice.voucherLetter}"</span>
      <span>${dateStr}</span>
    </div>
    <div class="row">
      <span>Cliente:</span>
      <span class="bold">${invoice.customerName}</span>
    </div>
    ${
      invoice.customerDocNumber && invoice.customerDocNumber !== '0'
        ? `<div class="row"><span>Doc:</span><span>${invoice.customerDocNumber}</span></div>`
        : ''
    }

    <div class="divider"></div>
    <div class="row bold">
      <span>DESCRIPCIÓN</span>
      <span>IMPORTE</span>
    </div>
    <div class="divider"></div>

    ${invoice.items
      .map(
        (it) => `
      <div style="margin-bottom: 4px;">
        <div>${it.description}</div>
        <div class="row" style="color: #444;">
          <span>${Number(it.quantity)} x $${Number(it.unitPrice).toFixed(2)}</span>
          <span>$${Number(it.totalSubtotal).toFixed(2)}</span>
        </div>
      </div>`
      )
      .join('')}

    <div class="divider"></div>
    <div class="row bold" style="font-size: 14px;">
      <span>TOTAL:</span>
      <span>$${Number(invoice.totalAmount).toFixed(2)}</span>
    </div>
    <div class="double-divider"></div>

    ${
      invoice.cae
        ? `
      <div class="row">
        <span>CAE N°:</span>
        <span class="bold">${invoice.cae}</span>
      </div>
      <div class="row">
        <span>Vto. CAE:</span>
        <span>${invoice.caeExpiresAt ? new Date(invoice.caeExpiresAt).toLocaleDateString('es-AR', { timeZone: 'UTC' }) : '-'}</span>
      </div>
      <div class="text-center" style="font-size: 10px; margin-top: 4px;">Comprobante Autorizado por ARCA (AFIP)</div>
      ${qrDataUrl ? `<div class="qr-container"><img src="${qrDataUrl}" alt="QR Fiscal" /></div>` : ''}
    `
        : '<div class="text-center bold">NO VALIDO COMO FACTURA</div>'
    }

    <div class="double-divider"></div>
  </div>
</body>
</html>`;
  }
}
