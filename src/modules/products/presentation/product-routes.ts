import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { ProductService } from '../application/product-service.js';
import { authenticate, requireTenant } from '../../../core/security/auth-middleware.js';

export const productRoutes: FastifyPluginAsyncTypebox = async (fastify) => {
  const productService = new ProductService();

  // Todos los endpoints de productos requieren un comercio autenticado
  fastify.addHook('preHandler', authenticate);
  fastify.addHook('preHandler', requireTenant);

  // POST /api/v1/products - Crear producto
  fastify.post(
    '/api/v1/products',
    {
      schema: {
        description: 'Crea o registra un producto o servicio en el catálogo del comercio',
        tags: ['Products'],
        security: [{ apiKeyAuth: [] }],
        body: Type.Object({
          name: Type.String({ minLength: 2, description: 'Nombre o descripción del producto' }),
          internalCode: Type.Optional(Type.String({ description: 'SKU o código interno' })),
          barcode: Type.Optional(Type.String({ description: 'Código de barras para scanner' })),
          description: Type.Optional(Type.String()),
          conceptType: Type.Optional(Type.Integer({ default: 1, description: '1: Productos, 2: Servicios, 3: Ambos' })),
          unitMeasure: Type.Optional(Type.String({ default: 'UNIDAD' })),
          costPrice: Type.Optional(Type.Number({ minimum: 0, default: 0 })),
          salePrice: Type.Number({ minimum: 0, description: 'Precio de venta' }),
          ivaRate: Type.Optional(Type.Number({ default: 21.0, description: 'Alícuota IVA (21, 10.5, 0, 27, etc.)' })),
          metadata: Type.Optional(Type.Any())
        }),
        response: {
          201: Type.Object({
            id: Type.String(),
            name: Type.String(),
            internalCode: Type.Union([Type.String(), Type.Null()]),
            barcode: Type.Union([Type.String(), Type.Null()]),
            description: Type.Union([Type.String(), Type.Null()]),
            conceptType: Type.Integer(),
            unitMeasure: Type.String(),
            unitMeasureCode: Type.Integer(),
            costPrice: Type.String(),
            salePrice: Type.String(),
            ivaRate: Type.String(),
            ivaCode: Type.Integer(),
            active: Type.Boolean(),
            createdAt: Type.String()
          })
        }
      }
    },
    async (request, reply) => {
      const tenantId = request.tenant!.id;
      const created = await productService.createProduct(tenantId, request.body, request.authContext?.apiKeyId);

      return reply.status(201).send({
        id: created.id,
        name: created.name,
        internalCode: created.internalCode,
        barcode: created.barcode,
        description: created.description,
        conceptType: created.conceptType,
        unitMeasure: created.unitMeasure,
        unitMeasureCode: created.unitMeasureCode,
        costPrice: created.costPrice,
        salePrice: created.salePrice,
        ivaRate: created.ivaRate,
        ivaCode: created.ivaCode,
        active: created.active,
        createdAt: created.createdAt.toISOString()
      });
    }
  );

  // GET /api/v1/products - Listar y buscar productos
  fastify.get(
    '/api/v1/products',
    {
      schema: {
        description: 'Lista y busca productos por nombre, código interno o código de barras',
        tags: ['Products'],
        security: [{ apiKeyAuth: [] }],
        querystring: Type.Object({
          search: Type.Optional(Type.String()),
          barcode: Type.Optional(Type.String()),
          activeOnly: Type.Optional(Type.Boolean({ default: true })),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 50 })),
          offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 }))
        }),
        response: {
          200: Type.Array(
            Type.Object({
              id: Type.String(),
              name: Type.String(),
              internalCode: Type.Union([Type.String(), Type.Null()]),
              barcode: Type.Union([Type.String(), Type.Null()]),
              description: Type.Union([Type.String(), Type.Null()]),
              conceptType: Type.Integer(),
              unitMeasure: Type.String(),
              unitMeasureCode: Type.Integer(),
              costPrice: Type.String(),
              salePrice: Type.String(),
              ivaRate: Type.String(),
              ivaCode: Type.Integer(),
              active: Type.Boolean(),
              createdAt: Type.String()
            })
          )
        }
      }
    },
    async (request, reply) => {
      const tenantId = request.tenant!.id;
      const list = await productService.listProducts(tenantId, request.query);

      return reply.send(
        list.map((p) => ({
          id: p.id,
          name: p.name,
          internalCode: p.internalCode,
          barcode: p.barcode,
          description: p.description,
          conceptType: p.conceptType,
          unitMeasure: p.unitMeasure,
          unitMeasureCode: p.unitMeasureCode,
          costPrice: p.costPrice,
          salePrice: p.salePrice,
          ivaRate: p.ivaRate,
          ivaCode: p.ivaCode,
          active: p.active,
          createdAt: p.createdAt.toISOString()
        }))
      );
    }
  );

  // GET /api/v1/products/:id - Obtener producto por ID
  fastify.get(
    '/api/v1/products/:id',
    {
      schema: {
        description: 'Obtiene el detalle de un producto específico',
        tags: ['Products'],
        security: [{ apiKeyAuth: [] }],
        params: Type.Object({
          id: Type.String({ format: 'uuid' })
        }),
        response: {
          200: Type.Object({
            id: Type.String(),
            name: Type.String(),
            internalCode: Type.Union([Type.String(), Type.Null()]),
            barcode: Type.Union([Type.String(), Type.Null()]),
            description: Type.Union([Type.String(), Type.Null()]),
            conceptType: Type.Integer(),
            unitMeasure: Type.String(),
            unitMeasureCode: Type.Integer(),
            costPrice: Type.String(),
            salePrice: Type.String(),
            ivaRate: Type.String(),
            ivaCode: Type.Integer(),
            active: Type.Boolean(),
            createdAt: Type.String()
          })
        }
      }
    },
    async (request, reply) => {
      const tenantId = request.tenant!.id;
      const p = await productService.getProductById(tenantId, request.params.id);

      return reply.send({
        id: p.id,
        name: p.name,
        internalCode: p.internalCode,
        barcode: p.barcode,
        description: p.description,
        conceptType: p.conceptType,
        unitMeasure: p.unitMeasure,
        unitMeasureCode: p.unitMeasureCode,
        costPrice: p.costPrice,
        salePrice: p.salePrice,
        ivaRate: p.ivaRate,
        ivaCode: p.ivaCode,
        active: p.active,
        createdAt: p.createdAt.toISOString()
      });
    }
  );

  // PATCH /api/v1/products/:id - Actualizar producto
  fastify.patch(
    '/api/v1/products/:id',
    {
      schema: {
        description: 'Actualiza datos o precios de un producto',
        tags: ['Products'],
        security: [{ apiKeyAuth: [] }],
        params: Type.Object({
          id: Type.String({ format: 'uuid' })
        }),
        body: Type.Object({
          name: Type.Optional(Type.String({ minLength: 2 })),
          internalCode: Type.Optional(Type.String()),
          barcode: Type.Optional(Type.String()),
          description: Type.Optional(Type.String()),
          conceptType: Type.Optional(Type.Integer()),
          unitMeasure: Type.Optional(Type.String()),
          costPrice: Type.Optional(Type.Number({ minimum: 0 })),
          salePrice: Type.Optional(Type.Number({ minimum: 0 })),
          ivaRate: Type.Optional(Type.Number()),
          active: Type.Optional(Type.Boolean()),
          metadata: Type.Optional(Type.Any())
        }),
        response: {
          200: Type.Object({
            id: Type.String(),
            name: Type.String(),
            internalCode: Type.Union([Type.String(), Type.Null()]),
            barcode: Type.Union([Type.String(), Type.Null()]),
            description: Type.Union([Type.String(), Type.Null()]),
            conceptType: Type.Integer(),
            unitMeasure: Type.String(),
            unitMeasureCode: Type.Integer(),
            costPrice: Type.String(),
            salePrice: Type.String(),
            ivaRate: Type.String(),
            ivaCode: Type.Integer(),
            active: Type.Boolean(),
            updatedAt: Type.String()
          })
        }
      }
    },
    async (request, reply) => {
      const tenantId = request.tenant!.id;
      const updated = await productService.updateProduct(
        tenantId,
        request.params.id,
        request.body,
        request.authContext?.apiKeyId
      );

      return reply.send({
        id: updated.id,
        name: updated.name,
        internalCode: updated.internalCode,
        barcode: updated.barcode,
        description: updated.description,
        conceptType: updated.conceptType,
        unitMeasure: updated.unitMeasure,
        unitMeasureCode: updated.unitMeasureCode,
        costPrice: updated.costPrice,
        salePrice: updated.salePrice,
        ivaRate: updated.ivaRate,
        ivaCode: updated.ivaCode,
        active: updated.active,
        updatedAt: updated.updatedAt.toISOString()
      });
    }
  );

  // DELETE /api/v1/products/:id - Archivar producto (baja lógica)
  fastify.delete(
    '/api/v1/products/:id',
    {
      schema: {
        description: 'Archiva un producto (baja lógica)',
        tags: ['Products'],
        security: [{ apiKeyAuth: [] }],
        params: Type.Object({
          id: Type.String({ format: 'uuid' })
        }),
        response: {
          200: Type.Object({
            message: Type.String()
          })
        }
      }
    },
    async (request, reply) => {
      const tenantId = request.tenant!.id;
      await productService.archiveProduct(tenantId, request.params.id, request.authContext?.apiKeyId);

      return reply.send({
        message: 'Producto archivado exitosamente'
      });
    }
  );

  // POST /api/v1/products/import-csv - Importar productos en lote desde CSV
  fastify.post(
    '/api/v1/products/import-csv',
    {
      schema: {
        description: 'Importa masivamente productos a partir de contenido CSV plano',
        tags: ['Products'],
        security: [{ apiKeyAuth: [] }],
        body: Type.Object({
          csvContent: Type.String({ description: 'Contenido del archivo CSV con cabeceras' })
        }),
        response: {
          200: Type.Object({
            totalProcessed: Type.Integer(),
            created: Type.Integer(),
            updated: Type.Integer(),
            errors: Type.Array(
              Type.Object({
                line: Type.Integer(),
                error: Type.String()
              })
            )
          })
        }
      }
    },
    async (request, reply) => {
      const tenantId = request.tenant!.id;
      const res = await productService.importFromCsv(tenantId, request.body.csvContent, request.authContext?.apiKeyId);
      return reply.send(res);
    }
  );

  // GET /api/v1/products/export-csv - Exportar catálogo a CSV
  fastify.get(
    '/api/v1/products/export-csv',
    {
      schema: {
        description: 'Exporta el catálogo de productos del comercio en formato CSV',
        tags: ['Products'],
        security: [{ apiKeyAuth: [] }]
      }
    },
    async (request, reply) => {
      const tenantId = request.tenant!.id;
      const csv = await productService.exportToCsv(tenantId);

      reply.header('Content-Type', 'text/csv; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="productos-${request.tenant!.slug}.csv"`);
      return reply.send(csv);
    }
  );
};
