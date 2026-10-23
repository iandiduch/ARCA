import nodemailer, { type Transporter } from 'nodemailer';
import type { FullInvoice } from '../../invoices/infrastructure/invoice-repository.js';
import type { FiscalIdentity } from '../../../infrastructure/database/schema/fiscal-identities.js';
import { InvoicePdfService } from '../../documents/application/invoice-pdf-service.js';
import { AuditService } from '../../audit/application/audit-service.js';
import { logger } from '../../../app/logger.js';

export interface SendInvoiceEmailOptions {
  to: string;
  subject?: string | undefined;
  customMessage?: string | undefined;
}

export interface EmailSendResult {
  success: boolean;
  messageId?: string | undefined;
  sentTo: string;
  simulated?: boolean | undefined;
}

export class EmailService {
  private transporter: Transporter | null = null;

  constructor() {
    const smtpHost = process.env.SMTP_HOST;
    if (smtpHost) {
      this.transporter = nodemailer.createTransport({
        host: smtpHost,
        port: Number(process.env.SMTP_PORT ?? 587),
        secure: process.env.SMTP_SECURE === 'true',
        auth: {
          user: process.env.SMTP_USER ?? '',
          pass: process.env.SMTP_PASS ?? ''
        }
      });
    }
  }

  /**
   * Envía el comprobante fiscal en formato PDF adjunto al correo del destinatario
   */
  public async sendInvoicePdf(
    tenantId: string,
    invoice: FullInvoice,
    identity: FiscalIdentity,
    options: SendInvoiceEmailOptions,
    userId?: string
  ): Promise<EmailSendResult> {
    const pdfBuffer = await InvoicePdfService.generatePdf(invoice, identity);
    const ptoVta = String(invoice.pointOfSaleNumber).padStart(5, '0');
    const nroComp = invoice.voucherNumber ? String(invoice.voucherNumber).padStart(8, '0') : 'BORRADOR';
    const filename = `Comprobante_${invoice.voucherLetter}_${ptoVta}-${nroComp}.pdf`;

    const subject =
      options.subject ??
      `Factura Electrónica ${invoice.voucherLetter} ${ptoVta}-${nroComp} - ${identity.businessName}`;

    const textBody =
      options.customMessage ??
      `Estimado/a ${invoice.customerName},\n\nAdjuntamos su comprobante fiscal electrónico emitido conforme a las normativas de ARCA (AFIP).\n\nTotal: $${Number(invoice.totalAmount).toFixed(2)}\n${invoice.cae ? `CAE: ${invoice.cae}` : ''}\n\nGracias por su compra.\n${identity.businessName}`;

    if (this.transporter) {
      const info = await this.transporter.sendMail({
        from: process.env.SMTP_FROM ?? `no-reply@${identity.businessName.toLowerCase().replace(/\s+/g, '')}.com`,
        to: options.to,
        subject,
        text: textBody,
        attachments: [
          {
            filename,
            content: pdfBuffer,
            contentType: 'application/pdf'
          }
        ]
      });

      await AuditService.record({
        tenantId,
        apiKeyId: userId,
        action: 'INVOICE_EMAIL_SENT',
        entityType: 'invoice',
        entityId: invoice.id,
        payload: { sentTo: options.to, messageId: info.messageId }
      });

      return {
        success: true,
        messageId: info.messageId,
        sentTo: options.to,
        simulated: false
      };
    }

    // Modo simulado / desarrollo cuando no hay servidor SMTP configurado
    const simulatedId = `sim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    logger.info(
      { invoiceId: invoice.id, to: options.to, simulatedId },
      'Simulación de envío de correo electrónico con PDF adjunto (sin servidor SMTP activo)'
    );

    await AuditService.record({
      tenantId,
      apiKeyId: userId,
      action: 'INVOICE_EMAIL_SENT',
      entityType: 'invoice',
      entityId: invoice.id,
      payload: { sentTo: options.to, messageId: simulatedId, simulated: true }
    });

    return {
      success: true,
      messageId: simulatedId,
      sentTo: options.to,
      simulated: true
    };
  }
}
