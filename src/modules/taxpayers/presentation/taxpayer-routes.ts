import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { TaxpayerService } from '../application/taxpayer-service.js';
import { authenticate, requireTenant } from '../../../core/security/auth-middleware.js';

export const taxpayerRoutes: FastifyPluginAsyncTypebox = async (fastify) => {
  const taxpayerService = new TaxpayerService();

  fastify.addHook('preHandler', authenticate);
  fastify.addHook('preHandler', requireTenant);

  // GET /api/v1/taxpayers/:cuit - Consulta oficial de CUIT en Padrón ARCA
  fastify.get(
    '/api/v1/taxpayers/:cuit',
    {
      schema: {
        summary: 'Consultar datos fiscales en el Padrón oficial de ARCA',
        description: 'Obtiene la Razón Social, Condición frente al IVA, Estado y Domicilio fiscal a partir de un CUIT verificado por Módulo 11.',
        tags: ['Padrón de Contribuyentes'],
        security: [{ apiKeyAuth: [] }],
        headers: Type.Object({
          'x-api-key': Type.String({ description: 'API Key del comercio' })
        }),
        params: Type.Object({
          cuit: Type.String({ minLength: 11, maxLength: 13, description: 'CUIT a consultar (con o sin guiones)' })
        })
      }
    },
    async (request, reply) => {
      const tenant = request.tenant!;
      const result = await taxpayerService.getTaxpayerByCuit(tenant.id, request.params.cuit);
      return reply.send(result);
    }
  );
};
