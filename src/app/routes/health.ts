import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { checkDatabaseConnection } from '../../infrastructure/database/connection.js';

export const healthRoutes: FastifyPluginAsyncTypebox = async (fastify) => {
  // GET /health/live - Liveness Probe
  fastify.get(
    '/health/live',
    {
      schema: {
        description: 'Liveness probe que confirma que el proceso HTTP responde',
        tags: ['Health'],
        response: {
          200: Type.Object({
            status: Type.Literal('alive'),
            timestamp: Type.String(),
            uptimeSeconds: Type.Number()
          })
        }
      }
    },
    async (_request, reply) => {
      return reply.send({
        status: 'alive',
        timestamp: new Date().toISOString(),
        uptimeSeconds: Math.floor(process.uptime())
      });
    }
  );

  // GET /health/ready - Readiness Probe
  fastify.get(
    '/health/ready',
    {
      schema: {
        description: 'Readiness probe que verifica dependencias críticas (PostgreSQL)',
        tags: ['Health'],
        response: {
          200: Type.Object({
            status: Type.Literal('ready'),
            database: Type.Object({
              ok: Type.Boolean(),
              latencyMs: Type.Optional(Type.Number())
            }),
            timestamp: Type.String()
          }),
          503: Type.Object({
            status: Type.Literal('not_ready'),
            database: Type.Object({
              ok: Type.Boolean(),
              error: Type.Optional(Type.String())
            }),
            timestamp: Type.String()
          })
        }
      }
    },
    async (_request, reply) => {
      const dbStatus = await checkDatabaseConnection();

      if (!dbStatus.ok) {
        return reply.status(503).send({
          status: 'not_ready',
          database: dbStatus.error !== undefined ? { ok: false, error: dbStatus.error } : { ok: false },
          timestamp: new Date().toISOString()
        });
      }

      return reply.send({
        status: 'ready',
        database: dbStatus.latencyMs !== undefined ? { ok: true, latencyMs: dbStatus.latencyMs } : { ok: true },
        timestamp: new Date().toISOString()
      });
    }
  );
};
