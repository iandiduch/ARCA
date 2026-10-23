import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type, type Static } from '@sinclair/typebox';
import { InvoiceService } from '../application/invoice-service.js';
import { authenticate, requireTenant } from '../../../core/security/auth-middleware.js';

const CustomerInputSchema = Type.Optional(
  Type.Object({
    docType: Type.Optional(Type.Integer({ description: 'Código AFIP: 80=CUIT, 96=DNI, 99=Consumidor Final', default: 99 })),
    docNumber: Type.Optional(Type.String({ description: 'Número de documento o CUIT (sin guiones)', default: '0' })),
    name: Type.Optional(Type.String({ description: 'Nombre o Razón Social del cliente', default: 'Consumidor Final' })),
    taxCondition: Type.Optional(Type.Integer({ description: '1=Resp. Inscripto, 5=Consumidor Final, 6=Monotributo, 4=Exento' })),
    address: Type.Optional(Type.String({ description: 'Domicilio fiscal o comercial' }))
  })
);

const InvoiceItemInputSchema = Type.Object({
  productId: Type.Optional(Type.String({ format: 'uuid', description: 'ID opcional del catálogo de productos' })),
  internalCode: Type.Optional(Type.String({ description: 'Código interno o SKU del producto en el POS' })),
  description: Type.String({ minLength: 1, description: 'Descripción del ítem o servicio' }),
  quantity: Type.Number({ minimum: 0.0001, description: 'Cantidad vendida' }),
  unitPrice: Type.Number({ minimum: 0, description: 'Precio unitario' }),
  discount: Type.Optional(Type.Number({ minimum: 0, default: 0, description: 'Descuento aplicado al ítem' })),
  vatRate: Type.Optional(Type.Number({ description: 'Alícuota de IVA (21, 10.5, 0, 27)', default: 21 })),
  vatAfipCode: Type.Optional(Type.Integer({ description: 'Código AFIP de alícuota (5=21%, 4=10.5%, 3=0%, 6=27%)' }))
});

const AssociatedVoucherInputSchema = Type.Object({
  voucherType: Type.Integer({ description: 'Tipo de comprobante original (1=Factura A, 6=Factura B, etc.)' }),
  pointOfSale: Type.Integer({ minimum: 1, maximum: 99999, description: 'Punto de venta del comprobante original' }),
  voucherNumber: Type.Integer({ minimum: 1, description: 'Número del comprobante original' }),
  cuit: Type.Optional(Type.String({ description: 'CUIT emisor del comprobante original (opcional si es del mismo comercio)' }))
});

const EmitInvoiceBodySchema = Type.Object({
  fiscalIdentityId: Type.String({ format: 'uuid', description: 'ID de la identidad fiscal habilitada' }),
  pointOfSaleNumber: Type.Integer({ minimum: 1, maximum: 99999, description: 'Número de punto de venta (1 a 99999)' }),
  voucherType: Type.Integer({ description: '1=Factura A, 6=Factura B, 11=Factura C, 3=NC A, 8=NC B, 13=NC C' }),
  concept: Type.Optional(Type.Integer({ minimum: 1, maximum: 3, default: 1, description: '1=Productos, 2=Servicios, 3=Productos y Servicios' })),
  serviceDateFrom: Type.Optional(Type.String({ description: 'Fecha inicio del servicio (YYYY-MM-DD)' })),
  serviceDateTo: Type.Optional(Type.String({ description: 'Fecha fin del servicio (YYYY-MM-DD)' })),
  paymentDueDate: Type.Optional(Type.String({ description: 'Fecha de vencimiento de pago (YYYY-MM-DD)' })),
  pricesIncludeVat: Type.Optional(Type.Boolean({ default: true, description: 'true si unitPrice incluye IVA (POS minorista), false si es precio neto' })),
  customerId: Type.Optional(Type.String({ format: 'uuid', description: 'ID opcional del cliente registrado' })),
  customer: CustomerInputSchema,
  items: Type.Array(InvoiceItemInputSchema, { minItems: 1, description: 'Lista de ítems facturados' }),
  associatedVouchers: Type.Optional(Type.Array(AssociatedVoucherInputSchema, { description: 'Comprobantes asociados (obligatorio para Notas de Crédito / Débito)' })),
  notes: Type.Optional(Type.String({ description: 'Observaciones comerciales en el comprobante' })),
  posSaleId: Type.Optional(Type.String({ description: 'UUID o identificador de venta en el POS' })),
  idempotencyKey: Type.Optional(Type.String({ description: 'Clave única para garantizar que no se duplique la emisión ante reintentos de red' }))
});

export const invoiceRoutes: FastifyPluginAsyncTypebox = async (fastify) => {
  const invoiceService = new InvoiceService();

  // Todos los endpoints de comprobantes requieren autenticación de comercio
  fastify.addHook('preHandler', authenticate);
  fastify.addHook('preHandler', requireTenant);

  // POST /api/v1/invoices - Emitir comprobante electrónico con CAE
  fastify.post(
    '/api/v1/invoices',
    {
      schema: {
        summary: 'Emitir comprobante electrónico con CAE',
        description: 'Emite una factura, nota de crédito o nota de débito directamente ante WSFEv1 de ARCA, devolviendo el CAE oficial y el QR de AFIP RG 5003.',
        tags: ['Facturación'],
        security: [{ apiKeyAuth: [] }],
        headers: Type.Object({
          'x-api-key': Type.String({ description: 'API Key del comercio' }),
          'x-idempotency-key': Type.Optional(Type.String({ description: 'Clave de idempotencia alternativa en cabecera' }))
        }),
        body: EmitInvoiceBodySchema
      }
    },
    async (request, reply) => {
      const tenant = request.tenant!;
      const headers = request.headers as { 'x-idempotency-key'?: string | undefined };
      const idempotencyHeader = headers['x-idempotency-key'];
      const body = request.body;
      const payload = {
        ...body,
        idempotencyKey: body.idempotencyKey || idempotencyHeader
      };

      const result = await invoiceService.emitInvoice(tenant.id, payload, request.authContext?.apiKeyId);
      return reply.code(201).send(result);
    }
  );

  // POST /api/v1/invoices/drafts - Crear borrador local
  fastify.post(
    '/api/v1/invoices/drafts',
    {
      schema: {
        summary: 'Crear borrador de comprobante',
        description: 'Registra un comprobante local preliminar con totales calculados sin solicitar CAE ni consumir numeración en ARCA.',
        tags: ['Facturación'],
        security: [{ apiKeyAuth: [] }],
        headers: Type.Object({
          'x-api-key': Type.String({ description: 'API Key del comercio' })
        }),
        body: EmitInvoiceBodySchema
      }
    },
    async (request, reply) => {
      const tenant = request.tenant!;
      const result = await invoiceService.createDraft(tenant.id, request.body, request.authContext?.apiKeyId);
      return reply.code(201).send(result);
    }
  );

  // POST /api/v1/invoices/:id/reconcile - Reconciliar comprobante ambiguo
  fastify.post(
    '/api/v1/invoices/:id/reconcile',
    {
      schema: {
        summary: 'Reconciliar comprobante pendiente de verificación',
        description: 'Consulta a ARCA (FECompConsultar) para determinar si un comprobante interrumpido durante la emisión fue registrado exitosamente con CAE o debe cancelarse.',
        tags: ['Facturación'],
        security: [{ apiKeyAuth: [] }],
        headers: Type.Object({
          'x-api-key': Type.String({ description: 'API Key del comercio' })
        }),
        params: Type.Object({
          id: Type.String({ format: 'uuid', description: 'ID del comprobante a reconciliar' })
        })
      }
    },
    async (request, reply) => {
      const tenant = request.tenant!;
      const result = await invoiceService.reconcileInvoice(tenant.id, request.params.id, request.authContext?.apiKeyId);
      return reply.send(result);
    }
  );

  // GET /api/v1/invoices - Listar comprobantes
  fastify.get(
    '/api/v1/invoices',
    {
      schema: {
        summary: 'Listar comprobantes emitidos y borradores',
        description: 'Consulta el historial de comprobantes con filtros por estado, fecha, punto de venta y paginación.',
        tags: ['Facturación'],
        security: [{ apiKeyAuth: [] }],
        headers: Type.Object({
          'x-api-key': Type.String({ description: 'API Key del comercio' })
        }),
        querystring: Type.Object({
          status: Type.Optional(Type.String({ description: 'Filtrar por estado: DRAFT, AUTHORIZED, REJECTED, PENDING_RECONCILIATION' })),
          fiscalIdentityId: Type.Optional(Type.String({ format: 'uuid' })),
          voucherType: Type.Optional(Type.Integer()),
          pointOfSaleNumber: Type.Optional(Type.Integer()),
          fromDate: Type.Optional(Type.String({ description: 'Fecha inicio (YYYY-MM-DD)' })),
          toDate: Type.Optional(Type.String({ description: 'Fecha fin (YYYY-MM-DD)' })),
          limit: Type.Optional(Type.Integer({ default: 50, minimum: 1, maximum: 100 })),
          offset: Type.Optional(Type.Integer({ default: 0, minimum: 0 }))
        })
      }
    },
    async (request, reply) => {
      const tenant = request.tenant!;
      const { fromDate, toDate, ...rest } = request.query;

      const result = await invoiceService.listInvoices(tenant.id, {
        ...rest,
        fromDate: fromDate ? new Date(fromDate) : undefined,
        toDate: toDate ? new Date(toDate) : undefined
      });

      return reply.send(result);
    }
  );

  // GET /api/v1/invoices/:id - Detalle completo de comprobante
  fastify.get(
    '/api/v1/invoices/:id',
    {
      schema: {
        summary: 'Obtener detalle completo de un comprobante',
        description: 'Devuelve los datos de cabecera, CAE, vencimiento, desglose de ítems, alícuotas de IVA y URL del QR de ARCA.',
        tags: ['Facturación'],
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
      const result = await invoiceService.getInvoiceById(tenant.id, request.params.id);
      return reply.send(result);
    }
  );
};
