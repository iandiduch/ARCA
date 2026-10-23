import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { TenantService } from '../application/tenant-service.js';
import { authenticate, requireMaster, requireTenant } from '../../../core/security/auth-middleware.js';
import { ForbiddenError } from '../../../core/errors/app-error.js';

export const tenantRoutes: FastifyPluginAsyncTypebox = async (fastify) => {
  const tenantService = new TenantService();

  // POST /api/v1/tenants - Crear nuevo comercio (Solo Clave Maestra de Plataforma)
  fastify.post(
    '/api/v1/tenants',
    {
      preHandler: [authenticate, requireMaster],
      schema: {
        description: 'Registra un nuevo comercio (tenant) en la plataforma (Exclusivo Administrador)',
        tags: ['Tenants'],
        security: [{ apiKeyAuth: [] }],
        body: Type.Object({
          name: Type.String({ minLength: 2, description: 'Razón social o nombre del comercio' }),
          slug: Type.String({ minLength: 2, description: 'Identificador único amigable (ej: onion-kiosco)' })
        }),
        response: {
          201: Type.Object({
            id: Type.String(),
            name: Type.String(),
            slug: Type.String(),
            active: Type.Boolean(),
            createdAt: Type.String()
          })
        }
      }
    },
    async (request, reply) => {
      const created = await tenantService.createTenant(request.body, 'master');
      return reply.status(201).send({
        id: created.id,
        name: created.name,
        slug: created.slug,
        active: created.active,
        createdAt: created.createdAt.toISOString()
      });
    }
  );

  // GET /api/v1/tenants - Listar comercios (Solo Clave Maestra)
  fastify.get(
    '/api/v1/tenants',
    {
      preHandler: [authenticate, requireMaster],
      schema: {
        description: 'Lista todos los comercios registrados en la plataforma',
        tags: ['Tenants'],
        security: [{ apiKeyAuth: [] }],
        response: {
          200: Type.Array(
            Type.Object({
              id: Type.String(),
              name: Type.String(),
              slug: Type.String(),
              active: Type.Boolean(),
              createdAt: Type.String()
            })
          )
        }
      }
    },
    async (_request, reply) => {
      const list = await tenantService.listTenants();
      return reply.send(
        list.map((t) => ({
          id: t.id,
          name: t.name,
          slug: t.slug,
          active: t.active,
          createdAt: t.createdAt.toISOString()
        }))
      );
    }
  );

  // GET /api/v1/tenants/me - Información del comercio autenticado
  fastify.get(
    '/api/v1/tenants/me',
    {
      preHandler: [authenticate, requireTenant],
      schema: {
        description: 'Obtiene los datos del comercio asociado a la API Key autenticada',
        tags: ['Tenants'],
        security: [{ apiKeyAuth: [] }],
        response: {
          200: Type.Object({
            id: Type.String(),
            name: Type.String(),
            slug: Type.String(),
            active: Type.Boolean(),
            createdAt: Type.String()
          })
        }
      }
    },
    async (request, reply) => {
      const tenant = request.tenant!;
      return reply.send({
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        active: tenant.active,
        createdAt: tenant.createdAt.toISOString()
      });
    }
  );

  // Helper para verificar aislamiento estricto: el llamador debe ser master o el dueño del tenant
  function checkTenantOwnership(requestTenantId: string | undefined, targetTenantId: string, isMaster: boolean) {
    if (!isMaster && requestTenantId !== targetTenantId) {
      throw new ForbiddenError('Violación de aislamiento: No tiene permisos para operar sobre este comercio');
    }
  }

  // POST /api/v1/tenants/:tenantId/api-keys - Generar nueva API Key para un comercio
  fastify.post(
    '/api/v1/tenants/:tenantId/api-keys',
    {
      preHandler: [authenticate],
      schema: {
        description: 'Genera una nueva API Key para que un sistema POS consuma la API fiscal',
        tags: ['Tenants'],
        security: [{ apiKeyAuth: [] }],
        params: Type.Object({
          tenantId: Type.String({ format: 'uuid' })
        }),
        body: Type.Object({
          name: Type.String({ minLength: 2, description: 'Etiqueta o nombre del POS (ej: Onion POS Caja 1)' }),
          role: Type.Optional(Type.String({ default: 'pos_client' })),
          environment: Type.Optional(Type.Union([Type.Literal('live'), Type.Literal('test')]))
        }),
        response: {
          201: Type.Object({
            id: Type.String(),
            tenantId: Type.String(),
            name: Type.String(),
            prefix: Type.String(),
            role: Type.String(),
            rawKey: Type.String({ description: 'Clave secreta. Se muestra ÚNICAMENTE una vez al momento de crearla.' }),
            createdAt: Type.String()
          })
        }
      }
    },
    async (request, reply) => {
      const isMaster = request.authContext?.type === 'master';
      checkTenantOwnership(request.tenant?.id, request.params.tenantId, isMaster);

      const apiKey = await tenantService.createApiKey(
        {
          tenantId: request.params.tenantId,
          name: request.body.name,
          role: request.body.role,
          environment: request.body.environment
        },
        request.tenant?.id ?? 'master'
      );

      return reply.status(201).send({
        id: apiKey.id,
        tenantId: apiKey.tenantId,
        name: apiKey.name,
        prefix: apiKey.prefix,
        role: apiKey.role,
        rawKey: apiKey.rawKey,
        createdAt: apiKey.createdAt.toISOString()
      });
    }
  );

  // GET /api/v1/tenants/:tenantId/api-keys - Listar API Keys de un comercio
  fastify.get(
    '/api/v1/tenants/:tenantId/api-keys',
    {
      preHandler: [authenticate],
      schema: {
        description: 'Lista las API Keys del comercio (sin exponer los secretos)',
        tags: ['Tenants'],
        security: [{ apiKeyAuth: [] }],
        params: Type.Object({
          tenantId: Type.String({ format: 'uuid' })
        }),
        response: {
          200: Type.Array(
            Type.Object({
              id: Type.String(),
              tenantId: Type.String(),
              name: Type.String(),
              prefix: Type.String(),
              role: Type.String(),
              active: Type.Boolean(),
              createdAt: Type.String(),
              lastUsedAt: Type.Union([Type.String(), Type.Null()])
            })
          )
        }
      }
    },
    async (request, reply) => {
      const isMaster = request.authContext?.type === 'master';
      checkTenantOwnership(request.tenant?.id, request.params.tenantId, isMaster);

      const keys = await tenantService.listApiKeys(request.params.tenantId);
      return reply.send(
        keys.map((k) => ({
          id: k.id,
          tenantId: k.tenantId,
          name: k.name,
          prefix: k.prefix,
          role: k.role,
          active: k.active,
          createdAt: k.createdAt.toISOString(),
          lastUsedAt: k.lastUsedAt ? k.lastUsedAt.toISOString() : null
        }))
      );
    }
  );

  // DELETE /api/v1/tenants/:tenantId/api-keys/:keyId - Revocar API Key
  fastify.delete(
    '/api/v1/tenants/:tenantId/api-keys/:keyId',
    {
      preHandler: [authenticate],
      schema: {
        description: 'Revoca inmediatamente una API Key activa de un comercio',
        tags: ['Tenants'],
        security: [{ apiKeyAuth: [] }],
        params: Type.Object({
          tenantId: Type.String({ format: 'uuid' }),
          keyId: Type.String({ format: 'uuid' })
        }),
        response: {
          200: Type.Object({
            message: Type.String()
          })
        }
      }
    },
    async (request, reply) => {
      const isMaster = request.authContext?.type === 'master';
      checkTenantOwnership(request.tenant?.id, request.params.tenantId, isMaster);

      await tenantService.revokeApiKey(
        request.params.tenantId,
        request.params.keyId,
        request.tenant?.id ?? 'master'
      );

      return reply.send({
        message: 'API Key revocada exitosamente'
      });
    }
  );
};
