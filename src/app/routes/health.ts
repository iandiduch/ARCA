import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { checkDatabaseConnection, getDatabasePoolStats } from '../../infrastructure/database/connection.js';
import { TaxpayerService } from '../../modules/taxpayers/application/taxpayer-service.js';

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

  // GET /health/metrics - Telemetría y Métricas Operativas
  fastify.get(
    '/health/metrics',
    {
      schema: {
        description: 'Métricas operativas del servidor, pool de base de datos y memoria',
        tags: ['Health'],
        response: {
          200: Type.Object({
            status: Type.Literal('ok'),
            timestamp: Type.String(),
            uptimeSeconds: Type.Number(),
            memory: Type.Object({
              heapUsedMb: Type.Number(),
              heapTotalMb: Type.Number(),
              rssMb: Type.Number()
            }),
            database: Type.Object({
              poolTotal: Type.Number(),
              poolIdle: Type.Number(),
              poolWaiting: Type.Number()
            }),
            caches: Type.Object({
              padronEntries: Type.Number()
            }),
            runtime: Type.Object({
              nodeVersion: Type.String(),
              platform: Type.String()
            })
          })
        }
      }
    },
    async (_request, reply) => {
      const mem = process.memoryUsage();
      const poolStats = getDatabasePoolStats();

      return reply.send({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptimeSeconds: Math.floor(process.uptime()),
        memory: {
          heapUsedMb: Math.round((mem.heapUsed / 1024 / 1024) * 100) / 100,
          heapTotalMb: Math.round((mem.heapTotal / 1024 / 1024) * 100) / 100,
          rssMb: Math.round((mem.rss / 1024 / 1024) * 100) / 100
        },
        database: {
          poolTotal: poolStats.total,
          poolIdle: poolStats.idle,
          poolWaiting: poolStats.waiting
        },
        caches: {
          padronEntries: TaxpayerService.getCacheSize()
        },
        runtime: {
          nodeVersion: process.version,
          platform: process.platform
        }
      });
    }
  );
};
