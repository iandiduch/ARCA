import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { ReportService } from '../application/report-service.js';
import { authenticate, requireTenant } from '../../../core/security/auth-middleware.js';
import { argentinaEndOfDay, argentinaStartOfDay } from '../../../core/fiscal/fiscal-dates.js';

export const reportRoutes: FastifyPluginAsyncTypebox = async (fastify) => {
  const reportService = new ReportService();

  fastify.addHook('preHandler', authenticate);
  fastify.addHook('preHandler', requireTenant);

  // GET /api/v1/reports/sales - Reporte de ventas y totales fiscales por período
  fastify.get(
    '/api/v1/reports/sales',
    {
      schema: {
        summary: 'Reporte consolidado de ventas y totales fiscales',
        description: 'Obtiene métricas de ventas facturadas, totales netos, totales de IVA, distribución por tipo de comprobante y tasas de IVA aplicables.',
        tags: ['Reportes Fiscales'],
        security: [{ apiKeyAuth: [] }],
        headers: Type.Object({
          'x-api-key': Type.String({ description: 'API Key del comercio' })
        }),
        querystring: Type.Object({
          fromDate: Type.Optional(Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Fecha inicio (YYYY-MM-DD, hora argentina)' })),
          toDate: Type.Optional(Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Fecha fin inclusiva (YYYY-MM-DD, hora argentina)' })),
          fiscalIdentityId: Type.Optional(Type.String({ format: 'uuid' })),
          pointOfSaleNumber: Type.Optional(Type.Integer()),
          voucherType: Type.Optional(Type.Integer())
        })
      }
    },
    async (request, reply) => {
      const tenant = request.tenant!;
      const { fromDate, toDate, ...rest } = request.query;

      const report = await reportService.getSalesReport(tenant.id, {
        ...rest,
        fromDate: fromDate ? argentinaStartOfDay(fromDate) : undefined,
        toDate: toDate ? argentinaEndOfDay(toDate) : undefined
      });

      return reply.send(report);
    }
  );

  // GET /api/v1/reports/vat-sales-ledger - Libro IVA Ventas Digital (JSON y CSV)
  fastify.get(
    '/api/v1/reports/vat-sales-ledger',
    {
      schema: {
        summary: 'Exportación de Libro IVA Ventas Digital (CSV y JSON)',
        description: 'Genera el Libro IVA Ventas exigido por la normativa argentina para presentación contable y conciliación impositiva.',
        tags: ['Reportes Fiscales'],
        security: [{ apiKeyAuth: [] }],
        headers: Type.Object({
          'x-api-key': Type.String({ description: 'API Key del comercio' })
        }),
        querystring: Type.Object({
          fromDate: Type.Optional(Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Fecha inicio (YYYY-MM-DD, hora argentina)' })),
          toDate: Type.Optional(Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Fecha fin inclusiva (YYYY-MM-DD, hora argentina)' })),
          fiscalIdentityId: Type.Optional(Type.String({ format: 'uuid' })),
          pointOfSaleNumber: Type.Optional(Type.Integer()),
          format: Type.Optional(Type.Union([Type.Literal('json'), Type.Literal('csv')], { default: 'json' }))
        })
      }
    },
    async (request, reply) => {
      const tenant = request.tenant!;
      const { fromDate, toDate, format, ...rest } = request.query;
      const filters = {
        ...rest,
        fromDate: fromDate ? argentinaStartOfDay(fromDate) : undefined,
        toDate: toDate ? argentinaEndOfDay(toDate) : undefined
      };

      if (format === 'csv') {
        const csvContent = await reportService.getVatSalesLedgerCsv(tenant.id, filters);
        const filename = `Libro_IVA_Ventas_${new Date().toISOString().slice(0, 10)}.csv`;

        return reply
          .header('Content-Type', 'text/csv; charset=utf-8')
          .header('Content-Disposition', `attachment; filename="${filename}"`)
          .send(csvContent);
      }

      const report = await reportService.getSalesReport(tenant.id, filters);
      return reply.send(report);
    }
  );
};
