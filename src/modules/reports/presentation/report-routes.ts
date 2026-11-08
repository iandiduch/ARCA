import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { ReportService } from '../application/report-service.js';
import { authenticate, requireTenant } from '../../../core/security/auth-middleware.js';
import { argentinaEndOfDay, argentinaStartOfDay } from '../../../core/fiscal/fiscal-dates.js';
import { ValidationError } from '../../../core/errors/app-error.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Rango por defecto cuando falta fromDate: últimos 90 días hasta toDate (o ahora) */
const DEFAULT_RANGE_DAYS = 90;
/** Rango máximo consultable, se omitan o no las fechas */
const MAX_RANGE_DAYS = 366;

/**
 * Resuelve SIEMPRE un rango acotado (M2/M10): sin fechas, los últimos 90 días; con una sola, se completa la otra;
 * y en todos los casos el rango no puede superar 366 días.
 */
function resolveReportRange(fromDate: string | undefined, toDate: string | undefined): { fromDate: Date; toDate: Date } {
  const to = toDate ? argentinaEndOfDay(toDate) : new Date();
  const from = fromDate ? argentinaStartOfDay(fromDate) : new Date(to.getTime() - DEFAULT_RANGE_DAYS * DAY_MS);
  if (to.getTime() < from.getTime()) {
    throw new ValidationError('La fecha toDate no puede ser anterior a fromDate');
  }
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS) {
    throw new ValidationError(`El rango máximo de consulta permitido es de ${MAX_RANGE_DAYS} días (indique fromDate y toDate)`);
  }
  return { fromDate: from, toDate: to };
}

export const reportRoutes: FastifyPluginAsyncTypebox = async (fastify) => {
  const reportService = new ReportService();

  fastify.addHook('preValidation', authenticate);
  fastify.addHook('preValidation', requireTenant);

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
          'x-api-key': Type.Optional(Type.String({ description: 'API Key del comercio' }))
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

      const range = resolveReportRange(fromDate, toDate);

      const report = await reportService.getSalesReport(tenant.id, { ...rest, ...range });

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
          'x-api-key': Type.Optional(Type.String({ description: 'API Key del comercio' }))
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

      const range = resolveReportRange(fromDate, toDate);

      const filters = { ...rest, ...range };

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
