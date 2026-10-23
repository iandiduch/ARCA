import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { AuditService } from '../application/audit-service.js';
import { authenticate, requireTenant } from '../../../core/security/auth-middleware.js';

export const auditRoutes: FastifyPluginAsyncTypebox = async (fastify) => {
  fastify.get(
    '/api/v1/audit-logs',
    {
      preHandler: [authenticate, requireTenant],
      schema: {
        description: 'Consulta el historial de auditoría de acciones sensibles del comercio autenticado',
        tags: ['Audit'],
        security: [{ apiKeyAuth: [] }],
        querystring: Type.Object({
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 50 })),
          offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 }))
        }),
        response: {
          200: Type.Array(
            Type.Object({
              id: Type.String(),
              tenantId: Type.Union([Type.String(), Type.Null()]),
              action: Type.String(),
              entityType: Type.String(),
              entityId: Type.Union([Type.String(), Type.Null()]),
              payload: Type.Optional(Type.Any()),
              createdAt: Type.String()
            })
          )
        }
      }
    },
    async (request, reply) => {
      const tenantId = request.tenant!.id;
      const limit = request.query.limit ?? 50;
      const offset = request.query.offset ?? 0;

      const logs = await AuditService.listByTenant(tenantId, limit, offset);

      return reply.send(
        logs.map((l) => ({
          id: l.id,
          tenantId: l.tenantId,
          action: l.action,
          entityType: l.entityType,
          entityId: l.entityId,
          payload: l.payload,
          createdAt: l.createdAt.toISOString()
        }))
      );
    }
  );
};
