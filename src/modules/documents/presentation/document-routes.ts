import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { InvoiceService } from '../../invoices/application/invoice-service.js';
import { FiscalIdentityRepository } from '../../fiscal-identities/infrastructure/fiscal-identity-repository.js';
import { InvoicePdfService } from '../application/invoice-pdf-service.js';
import { ThermalPrinterService } from '../application/thermal-printer-service.js';
import { QrService } from '../application/qr-service.js';
import { EmailService } from '../../notifications/application/email-service.js';
import { authenticate, requireTenant } from '../../../core/security/auth-middleware.js';
import { NotFoundError } from '../../../core/errors/app-error.js';

export const documentRoutes: FastifyPluginAsyncTypebox = async (fastify) => {
  const invoiceService = new InvoiceService();
  const fiscalRepo = new FiscalIdentityRepository();
  const emailService = new EmailService();

  fastify.addHook('preHandler', authenticate);
  fastify.addHook('preHandler', requireTenant);

  // GET /api/v1/invoices/:id/pdf - Descargar o visualizar PDF reglamentario
  fastify.get(
    '/api/v1/invoices/:id/pdf',
    {
      schema: {
        summary: 'Descargar comprobante fiscal en PDF reglamentario',
        description: 'Genera el documento PDF oficial con membrete, detalle impositivo, CAE y código QR según la normativa AFIP RG 1415 y RG 5003.',
        tags: ['Documentos e Impresión'],
        security: [{ apiKeyAuth: [] }],
        headers: Type.Object({
          'x-api-key': Type.String({ description: 'API Key del comercio' })
        }),
        params: Type.Object({
          id: Type.String({ format: 'uuid', description: 'ID del comprobante' })
        })
      }
    },
    async (request, reply) => {
      const tenant = request.tenant!;
      const invoice = await invoiceService.getInvoiceById(tenant.id, request.params.id);
      const identity = await fiscalRepo.findById(tenant.id, invoice.fiscalIdentityId);

      if (!identity) {
        throw new NotFoundError('Identidad fiscal emisora no encontrada');
      }

      const pdfBuffer = await InvoicePdfService.generatePdf(invoice, identity);
      const ptoVta = String(invoice.pointOfSaleNumber).padStart(5, '0');
      const nroComp = invoice.voucherNumber ? String(invoice.voucherNumber).padStart(8, '0') : 'DRAFT';
      const filename = `Comprobante_${invoice.voucherLetter}_${ptoVta}-${nroComp}.pdf`;

      return reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `inline; filename="${filename}"`)
        .send(pdfBuffer);
    }
  );

  // GET /api/v1/invoices/:id/thermal - Ticket para impresora térmica POS (80mm / 58mm)
  fastify.get(
    '/api/v1/invoices/:id/thermal',
    {
      schema: {
        summary: 'Obtener formato para ticketera térmica de punto de venta',
        description: 'Genera el ticket formateado en texto plano o HTML listo para impresoras térmicas de 80mm o 58mm.',
        tags: ['Documentos e Impresión'],
        security: [{ apiKeyAuth: [] }],
        headers: Type.Object({
          'x-api-key': Type.String({ description: 'API Key del comercio' })
        }),
        params: Type.Object({
          id: Type.String({ format: 'uuid', description: 'ID del comprobante' })
        }),
        querystring: Type.Object({
          widthMm: Type.Optional(Type.Union([Type.Literal(80), Type.Literal(58)], { default: 80 })),
          format: Type.Optional(Type.Union([Type.Literal('text'), Type.Literal('html')], { default: 'text' }))
        })
      }
    },
    async (request, reply) => {
      const tenant = request.tenant!;
      const invoice = await invoiceService.getInvoiceById(tenant.id, request.params.id);
      const identity = await fiscalRepo.findById(tenant.id, invoice.fiscalIdentityId);

      if (!identity) {
        throw new NotFoundError('Identidad fiscal emisora no encontrada');
      }

      const widthMm = (request.query.widthMm ?? 80) as 80 | 58;
      const format = (request.query.format ?? 'text') as 'text' | 'html';

      const result = await ThermalPrinterService.generate(invoice, identity, { widthMm, format });
      return reply.header('Content-Type', result.contentType).send(result.content);
    }
  );

  // GET /api/v1/invoices/:id/qr - Imagen o SVG del código QR fiscal
  fastify.get(
    '/api/v1/invoices/:id/qr',
    {
      schema: {
        summary: 'Descargar imagen del código QR fiscal oficial (RG 5003)',
        description: 'Renderiza el código QR oficial de AFIP en formato imagen PNG o vectorial SVG.',
        tags: ['Documentos e Impresión'],
        security: [{ apiKeyAuth: [] }],
        headers: Type.Object({
          'x-api-key': Type.String({ description: 'API Key del comercio' })
        }),
        params: Type.Object({
          id: Type.String({ format: 'uuid', description: 'ID del comprobante' })
        }),
        querystring: Type.Object({
          format: Type.Optional(Type.Union([Type.Literal('png'), Type.Literal('svg')], { default: 'png' })),
          width: Type.Optional(Type.Integer({ default: 200, minimum: 100, maximum: 600 }))
        })
      }
    },
    async (request, reply) => {
      const tenant = request.tenant!;
      const invoice = await invoiceService.getInvoiceById(tenant.id, request.params.id);

      const qrData = invoice.qrData ?? 'https://www.afip.gob.ar/fe/qr/';
      const format = request.query.format ?? 'png';
      const width = request.query.width ?? 200;

      if (format === 'svg') {
        const svgString = await QrService.generateSvg(qrData, width);
        return reply.header('Content-Type', 'image/svg+xml; charset=utf-8').send(svgString);
      }

      const pngBuffer = await QrService.generatePngBuffer(qrData, width);
      return reply.header('Content-Type', 'image/png').send(pngBuffer);
    }
  );

  // POST /api/v1/invoices/:id/email - Enviar comprobante por correo electrónico
  fastify.post(
    '/api/v1/invoices/:id/email',
    {
      schema: {
        summary: 'Enviar comprobante por correo electrónico con PDF adjunto',
        description: 'Envía un email al cliente con el PDF reglamentario de la factura adjunto y registra el evento en auditoría.',
        tags: ['Documentos e Impresión'],
        security: [{ apiKeyAuth: [] }],
        headers: Type.Object({
          'x-api-key': Type.String({ description: 'API Key del comercio' })
        }),
        params: Type.Object({
          id: Type.String({ format: 'uuid', description: 'ID del comprobante' })
        }),
        body: Type.Object({
          to: Type.String({ format: 'email', description: 'Correo electrónico del destinatario' }),
          subject: Type.Optional(Type.String({ description: 'Asunto personalizado del correo' })),
          customMessage: Type.Optional(Type.String({ description: 'Mensaje personalizado en el cuerpo del correo' }))
        })
      }
    },
    async (request, reply) => {
      const tenant = request.tenant!;
      const invoice = await invoiceService.getInvoiceById(tenant.id, request.params.id);
      const identity = await fiscalRepo.findById(tenant.id, invoice.fiscalIdentityId);

      if (!identity) {
        throw new NotFoundError('Identidad fiscal emisora no encontrada');
      }

      const result = await emailService.sendInvoicePdf(
        tenant.id,
        invoice,
        identity,
        request.body,
        request.authContext?.apiKeyId
      );

      return reply.send(result);
    }
  );
};
