import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { CustomerService } from '../application/customer-service.js';
import { authenticate, requireTenant } from '../../../core/security/auth-middleware.js';

export const customerRoutes: FastifyPluginAsyncTypebox = async (fastify) => {
  const customerService = new CustomerService();

  // Todos los endpoints de clientes requieren un comercio autenticado
  fastify.addHook('preHandler', authenticate);
  fastify.addHook('preHandler', requireTenant);

  // POST /api/v1/customers - Crear cliente
  fastify.post(
    '/api/v1/customers',
    {
      schema: {
        description: 'Crea o registra un cliente fiscal en el comercio',
        tags: ['Customers'],
        security: [{ apiKeyAuth: [] }],
        body: Type.Object({
          name: Type.String({ minLength: 2, description: 'Razón Social o Nombre' }),
          documentType: Type.Optional(
            Type.Union([
              Type.Literal('CUIT'),
              Type.Literal('CUIL'),
              Type.Literal('DNI'),
              Type.Literal('PASAPORTE'),
              Type.Literal('OTRO')
            ], { default: 'DNI' })
          ),
          documentNumber: Type.String({ minLength: 1, description: 'Número de documento o CUIT' }),
          fiscalCondition: Type.Optional(
            Type.Union([
              Type.Literal('CONSUMIDOR_FINAL'),
              Type.Literal('IVA_RESPONSABLE_INSCRIPTO'),
              Type.Literal('RESPONSABLE_MONOTRIBUTO'),
              Type.Literal('IVA_EXENTO'),
              Type.Literal('NO_RESPONSABLE')
            ], { default: 'CONSUMIDOR_FINAL' })
          ),
          email: Type.Optional(Type.String({ format: 'email' })),
          phone: Type.Optional(Type.String()),
          address: Type.Optional(Type.String())
        }),
        response: {
          201: Type.Object({
            id: Type.String(),
            name: Type.String(),
            documentType: Type.String(),
            documentTypeCode: Type.Integer(),
            documentNumber: Type.String(),
            fiscalCondition: Type.String(),
            fiscalConditionCode: Type.Integer(),
            email: Type.Union([Type.String(), Type.Null()]),
            phone: Type.Union([Type.String(), Type.Null()]),
            address: Type.Union([Type.String(), Type.Null()]),
            active: Type.Boolean(),
            createdAt: Type.String()
          })
        }
      }
    },
    async (request, reply) => {
      const tenantId = request.tenant!.id;
      const created = await customerService.createCustomer(tenantId, request.body, request.authContext?.apiKeyId);

      return reply.status(201).send({
        id: created.id,
        name: created.name,
        documentType: created.documentType,
        documentTypeCode: created.documentTypeCode,
        documentNumber: created.documentNumber,
        fiscalCondition: created.fiscalCondition,
        fiscalConditionCode: created.fiscalConditionCode,
        email: created.email,
        phone: created.phone,
        address: created.address,
        active: created.active,
        createdAt: created.createdAt.toISOString()
      });
    }
  );

  // GET /api/v1/customers - Listar y buscar clientes
  fastify.get(
    '/api/v1/customers',
    {
      schema: {
        description: 'Lista y busca clientes del comercio por nombre, documento o email',
        tags: ['Customers'],
        security: [{ apiKeyAuth: [] }],
        querystring: Type.Object({
          search: Type.Optional(Type.String()),
          activeOnly: Type.Optional(Type.Boolean({ default: true })),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 50 })),
          offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 }))
        }),
        response: {
          200: Type.Array(
            Type.Object({
              id: Type.String(),
              name: Type.String(),
              documentType: Type.String(),
              documentTypeCode: Type.Integer(),
              documentNumber: Type.String(),
              fiscalCondition: Type.String(),
              fiscalConditionCode: Type.Integer(),
              email: Type.Union([Type.String(), Type.Null()]),
              phone: Type.Union([Type.String(), Type.Null()]),
              address: Type.Union([Type.String(), Type.Null()]),
              active: Type.Boolean(),
              createdAt: Type.String()
            })
          )
        }
      }
    },
    async (request, reply) => {
      const tenantId = request.tenant!.id;
      const list = await customerService.listCustomers(tenantId, request.query);

      return reply.send(
        list.map((c) => ({
          id: c.id,
          name: c.name,
          documentType: c.documentType,
          documentTypeCode: c.documentTypeCode,
          documentNumber: c.documentNumber,
          fiscalCondition: c.fiscalCondition,
          fiscalConditionCode: c.fiscalConditionCode,
          email: c.email,
          phone: c.phone,
          address: c.address,
          active: c.active,
          createdAt: c.createdAt.toISOString()
        }))
      );
    }
  );

  // GET /api/v1/customers/:id - Obtener cliente por ID
  fastify.get(
    '/api/v1/customers/:id',
    {
      schema: {
        description: 'Obtiene el detalle de un cliente específico',
        tags: ['Customers'],
        security: [{ apiKeyAuth: [] }],
        params: Type.Object({
          id: Type.String({ format: 'uuid' })
        }),
        response: {
          200: Type.Object({
            id: Type.String(),
            name: Type.String(),
            documentType: Type.String(),
            documentTypeCode: Type.Integer(),
            documentNumber: Type.String(),
            fiscalCondition: Type.String(),
            fiscalConditionCode: Type.Integer(),
            email: Type.Union([Type.String(), Type.Null()]),
            phone: Type.Union([Type.String(), Type.Null()]),
            address: Type.Union([Type.String(), Type.Null()]),
            active: Type.Boolean(),
            createdAt: Type.String()
          })
        }
      }
    },
    async (request, reply) => {
      const tenantId = request.tenant!.id;
      const c = await customerService.getCustomerById(tenantId, request.params.id);

      return reply.send({
        id: c.id,
        name: c.name,
        documentType: c.documentType,
        documentTypeCode: c.documentTypeCode,
        documentNumber: c.documentNumber,
        fiscalCondition: c.fiscalCondition,
        fiscalConditionCode: c.fiscalConditionCode,
        email: c.email,
        phone: c.phone,
        address: c.address,
        active: c.active,
        createdAt: c.createdAt.toISOString()
      });
    }
  );

  // PATCH /api/v1/customers/:id - Actualizar cliente
  fastify.patch(
    '/api/v1/customers/:id',
    {
      schema: {
        description: 'Actualiza datos de un cliente',
        tags: ['Customers'],
        security: [{ apiKeyAuth: [] }],
        params: Type.Object({
          id: Type.String({ format: 'uuid' })
        }),
        body: Type.Object({
          name: Type.Optional(Type.String({ minLength: 2 })),
          documentType: Type.Optional(Type.String()),
          documentNumber: Type.Optional(Type.String()),
          fiscalCondition: Type.Optional(Type.String()),
          email: Type.Optional(Type.String()),
          phone: Type.Optional(Type.String()),
          address: Type.Optional(Type.String()),
          active: Type.Optional(Type.Boolean())
        }),
        response: {
          200: Type.Object({
            id: Type.String(),
            name: Type.String(),
            documentType: Type.String(),
            documentTypeCode: Type.Integer(),
            documentNumber: Type.String(),
            fiscalCondition: Type.String(),
            fiscalConditionCode: Type.Integer(),
            email: Type.Union([Type.String(), Type.Null()]),
            phone: Type.Union([Type.String(), Type.Null()]),
            address: Type.Union([Type.String(), Type.Null()]),
            active: Type.Boolean(),
            updatedAt: Type.String()
          })
        }
      }
    },
    async (request, reply) => {
      const tenantId = request.tenant!.id;
      const updated = await customerService.updateCustomer(
        tenantId,
        request.params.id,
        request.body,
        request.authContext?.apiKeyId
      );

      return reply.send({
        id: updated.id,
        name: updated.name,
        documentType: updated.documentType,
        documentTypeCode: updated.documentTypeCode,
        documentNumber: updated.documentNumber,
        fiscalCondition: updated.fiscalCondition,
        fiscalConditionCode: updated.fiscalConditionCode,
        email: updated.email,
        phone: updated.phone,
        address: updated.address,
        active: updated.active,
        updatedAt: updated.updatedAt.toISOString()
      });
    }
  );

  // DELETE /api/v1/customers/:id - Archivar cliente (baja lógica)
  fastify.delete(
    '/api/v1/customers/:id',
    {
      schema: {
        description: 'Archiva un cliente (baja lógica)',
        tags: ['Customers'],
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
      await customerService.archiveCustomer(tenantId, request.params.id, request.authContext?.apiKeyId);

      return reply.send({
        message: 'Cliente archivado exitosamente'
      });
    }
  );
};
