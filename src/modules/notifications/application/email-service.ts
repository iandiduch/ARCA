import nodemailer, { type Transporter } from 'nodemailer';
import type { FullInvoice } from '../../invoices/infrastructure/invoice-repository.js';
import type { FiscalIdentity } from '../../../infrastructure/database/schema/fiscal-identities.js';
import { InvoicePdfService } from '../../documents/application/invoice-pdf-service.js';
import { AuditService } from '../../audit/application/audit-service.js';
import { logger } from '../../../app/logger.js';
import { loadConfig } from '../../../app/config.js';
import { AppError, ValidationError } from '../../../core/errors/app-error.js';

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
  private readonly config = loadConfig();

  constructor() {
    if (this.config.SMTP_HOST) {
      this.transporter = nodemailer.createTransport({
        host: this.config.SMTP_HOST,
        port: this.config.SMTP_PORT,
        secure: this.config.SMTP_SECURE,
        auth: this.config.SMTP_USER
          ? { user: this.config.SMTP_USER, pass: this.config.SMTP_PASS ?? '' }
          : undefined
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
    if (!this.transporter && this.config.NODE_ENV === 'production') {
      throw new AppError(
        'El envío de comprobantes por email no está configurado en este servidor (falta SMTP_HOST).',
        503,
        'EMAIL_NOT_CONFIGURED'
      );
    }

    // Sólo comprobantes autorizados por ARCA: evita usar el endpoint para enviar contenido arbitrario
    if (invoice.status !== 'AUTHORIZED') {
      throw new ValidationError(
        `Sólo se pueden enviar por email comprobantes autorizados por ARCA (estado actual: ${invoice.status})`
      );
    }

    const sentLast24h = await AuditService.countRecentActions(
      tenantId,
      'INVOICE_EMAIL_SENT',
      invoice.id,
      new Date(Date.now() - 24 * 3600 * 1000)
    );
    if (sentLast24h >= this.config.EMAIL_MAX_SENDS_PER_INVOICE) {
      throw new AppError(
        `El comprobante ya fue enviado ${sentLast24h} veces en las últimas 24 horas (máximo ${this.config.EMAIL_MAX_SENDS_PER_INVOICE}).`,
        429,
        'EMAIL_SEND_LIMIT_EXCEEDED'
      );
    }

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
        from: this.config.SMTP_FROM ?? this.config.SMTP_USER,
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
