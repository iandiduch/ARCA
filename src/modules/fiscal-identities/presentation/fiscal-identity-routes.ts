import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { FiscalIdentityService } from '../application/fiscal-identity-service.js';
import { Wsfev1Client } from '../../arca/infrastructure/wsfev1/wsfev1-client.js';
import { authenticate, requireTenant } from '../../../core/security/auth-middleware.js';

export const fiscalIdentityRoutes: FastifyPluginAsyncTypebox = async (fastify) => {
  const service = new FiscalIdentityService();

  // Endpoint de diagnóstico rápido de servidores ARCA (FEDummy)
  fastify.get(
    '/api/v1/arca/dummy',
    {
      preHandler: [authenticate],
      schema: {
        description: 'Verifica la disponibilidad en tiempo real de los servidores de ARCA (FEDummy)',
        tags: ['ARCA'],
        security: [{ apiKeyAuth: [] }],
        querystring: Type.Object({
          environment: Type.Optional(Type.Union([Type.Literal('homologation'), Type.Literal('production')]))
        }),
        response: {
          200: Type.Object({
            appServer: Type.String(),
            dbServer: Type.String(),
            authServer: Type.String(),
            isOk: Type.Boolean(),
            environment: Type.String()
          })
        }
      }
    },
    async (request, reply) => {
      const environment = request.query.environment ?? 'homologation';
      const result = await Wsfev1Client.dummy({ environment });
      return reply.send({
        ...result,
        environment
      });
    }
  );

  // POST /api/v1/fiscal-identities - Registrar identidad fiscal
  fastify.post(
    '/api/v1/fiscal-identities',
    {
      preHandler: [authenticate, requireTenant],
      schema: {
        description: 'Registra un CUIT o identidad fiscal para un comercio (Paso 1 del asistente)',
        tags: ['Fiscal Identities'],
        security: [{ apiKeyAuth: [] }],
        body: Type.Object({
          cuit: Type.String({ minLength: 11, maxLength: 13, description: 'CUIT del contribuyente emisor' }),
          businessName: Type.String({ minLength: 2, description: 'Razón Social o Nombre del titular' }),
          environment: Type.Optional(
            Type.Union([Type.Literal('homologation'), Type.Literal('production')], { default: 'homologation' })
          ),
          taxCondition: Type.Optional(Type.String({ default: 'RESPONSABLE_MONOTRIBUTO' })),
          grossIncomeNumber: Type.Optional(Type.String()),
          activityStartDate: Type.Optional(Type.String()),
          connectionType: Type.Optional(
            Type.Union([Type.Literal('DELEGATION'), Type.Literal('OWN_CERTIFICATE')], { default: 'DELEGATION' })
          )
        }),
        response: {
          201: Type.Object({
            id: Type.String(),
            cuit: Type.String(),
            businessName: Type.String(),
            environment: Type.String(),
            connectionType: Type.String(),
            status: Type.String(),
            statusReason: Type.Union([Type.String(), Type.Null()]),
            createdAt: Type.String()
          })
        }
      }
    },
    async (request, reply) => {
      const tenantId = request.tenant!.id;
      const created = await service.createIdentity(tenantId, request.body, request.authContext?.apiKeyId);

      return reply.status(201).send({
        id: created.id,
        cuit: created.cuit,
        businessName: created.businessName,
        environment: created.environment,
        connectionType: created.connectionType,
        status: created.status,
        statusReason: created.statusReason,
        createdAt: created.createdAt.toISOString()
      });
    }
  );

  // GET /api/v1/fiscal-identities - Listar identidades fiscales del comercio
  fastify.get(
    '/api/v1/fiscal-identities',
    {
      preHandler: [authenticate, requireTenant],
      schema: {
        description: 'Lista las identidades fiscales configuradas para el comercio',
        tags: ['Fiscal Identities'],
        security: [{ apiKeyAuth: [] }],
        response: {
          200: Type.Array(
            Type.Object({
              id: Type.String(),
              cuit: Type.String(),
              businessName: Type.String(),
              environment: Type.String(),
              connectionType: Type.String(),
              status: Type.String(),
              statusReason: Type.Union([Type.String(), Type.Null()]),
              lastValidatedAt: Type.Union([Type.String(), Type.Null()]),
              createdAt: Type.String()
            })
          )
        }
      }
    },
    async (request, reply) => {
      const tenantId = request.tenant!.id;
      const list = await service.listIdentities(tenantId);

      return reply.send(
        list.map((i) => ({
          id: i.id,
          cuit: i.cuit,
          businessName: i.businessName,
          environment: i.environment,
          connectionType: i.connectionType,
          status: i.status,
          statusReason: i.statusReason,
          lastValidatedAt: i.lastValidatedAt ? i.lastValidatedAt.toISOString() : null,
          createdAt: i.createdAt.toISOString()
        }))
      );
    }
  );

  // GET /api/v1/fiscal-identities/:id/status - Estado del asistente de vinculación
  fastify.get(
    '/api/v1/fiscal-identities/:id/status',
    {
      preHandler: [authenticate, requireTenant],
      schema: {
        description: 'Consulta el estado detallado de la conexión con ARCA y pasos pendientes',
        tags: ['Fiscal Identities'],
        security: [{ apiKeyAuth: [] }],
        params: Type.Object({
          id: Type.String({ format: 'uuid' })
        }),
        response: {
          200: Type.Object({
            id: Type.String(),
            cuit: Type.String(),
            businessName: Type.String(),
            environment: Type.String(),
            connectionType: Type.String(),
            status: Type.String(),
            statusReason: Type.Union([Type.String(), Type.Null()]),
            lastValidatedAt: Type.Union([Type.String(), Type.Null()]),
            hasCertificate: Type.Boolean(),
            certificateValidTo: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            puntosVenta: Type.Array(
              Type.Object({
                id: Type.String(),
                number: Type.Integer(),
                type: Type.String(),
                active: Type.Boolean()
              })
            )
          })
        }
      }
    },
    async (request, reply) => {
      const tenantId = request.tenant!.id;
      const status = await service.getStatus(tenantId, request.params.id);

      return reply.send({
        ...status,
        lastValidatedAt: status.lastValidatedAt ? status.lastValidatedAt.toISOString() : null,
        certificateValidTo: status.certificateValidTo ? status.certificateValidTo.toISOString() : null
      });
    }
  );

  // POST /api/v1/fiscal-identities/:id/certificate-requests - Generar CSR
  fastify.post(
    '/api/v1/fiscal-identities/:id/certificate-requests',
    {
      preHandler: [authenticate, requireTenant],
      schema: {
        description: 'Genera automáticamente la clave RSA 2048 y el CSR para tramitar en ARCA (Paso 2)',
        tags: ['Fiscal Identities'],
        security: [{ apiKeyAuth: [] }],
        params: Type.Object({
          id: Type.String({ format: 'uuid' })
        }),
        response: {
          201: Type.Object({
            fiscalIdentityId: Type.String(),
            cuit: Type.String(),
            csrPem: Type.String(),
            instructions: Type.String()
          })
        }
      }
    },
    async (request, reply) => {
      const tenantId = request.tenant!.id;
      const result = await service.generateCertificateRequest(
        tenantId,
        request.params.id,
        request.authContext?.apiKeyId
      );
      return reply.status(201).send(result);
    }
  );

  // POST /api/v1/fiscal-identities/:id/certificates - Cargar certificado emitido
  fastify.post(
    '/api/v1/fiscal-identities/:id/certificates',
    {
      preHandler: [authenticate, requireTenant],
      schema: {
        description: 'Carga el certificado X.509 público emitido por ARCA para validar y activar (Paso 4)',
        tags: ['Fiscal Identities'],
        security: [{ apiKeyAuth: [] }],
        params: Type.Object({
          id: Type.String({ format: 'uuid' })
        }),
        body: Type.Object({
          certificatePem: Type.String({ description: 'Certificado en formato PEM (.crt)' })
        }),
        response: {
          200: Type.Object({
            message: Type.String(),
            metadata: Type.Object({
              validFrom: Type.String(),
              validTo: Type.String(),
              subject: Type.String(),
              issuer: Type.String(),
              serialNumber: Type.String(),
              fingerprint: Type.String(),
              isExpired: Type.Boolean()
            })
          })
        }
      }
    },
    async (request, reply) => {
      const tenantId = request.tenant!.id;
      const result = await service.uploadCertificate(
        tenantId,
        request.params.id,
        request.body.certificatePem,
        request.authContext?.apiKeyId
      );

      return reply.send({
        message: result.message,
        metadata: {
          ...result.metadata,
          validFrom: result.metadata.validFrom.toISOString(),
          validTo: result.metadata.validTo.toISOString()
        }
      });
    }
  );

  // POST /api/v1/fiscal-identities/:id/connection-tests - Validar conexión
  fastify.post(
    '/api/v1/fiscal-identities/:id/connection-tests',
    {
      preHandler: [authenticate, requireTenant],
      schema: {
        description: 'Prueba la conexión real contra WSAA y WSFEv1 detectando puntos de venta (Paso 5)',
        tags: ['Fiscal Identities'],
        security: [{ apiKeyAuth: [] }],
        params: Type.Object({
          id: Type.String({ format: 'uuid' })
        }),
        response: {
          200: Type.Object({
            ok: Type.Boolean(),
            status: Type.String(),
            message: Type.String(),
            puntosVenta: Type.Optional(
              Type.Array(
                Type.Object({
                  nro: Type.Integer(),
                  emisionTipo: Type.String(),
                  bloqueado: Type.Boolean()
                })
              )
            ),
            lastValidatedAt: Type.Optional(Type.Union([Type.String(), Type.Null()]))
          })
        }
      }
    },
    async (request, reply) => {
      const tenantId = request.tenant!.id;
      const result = await service.testConnection(
        tenantId,
        request.params.id,
        request.authContext?.apiKeyId
      );

      return reply.send({
        ...result,
        lastValidatedAt: result.lastValidatedAt ? result.lastValidatedAt.toISOString() : null
      });
    }
  );

  // DELETE /api/v1/fiscal-identities/:id - Eliminar identidad fiscal
  fastify.delete(
    '/api/v1/fiscal-identities/:id',
    {
      preHandler: [authenticate, requireTenant],
      schema: {
        description: 'Elimina una identidad fiscal del comercio (bloqueado si ya emitió comprobantes)',
        tags: ['Fiscal Identities'],
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
      await service.deleteIdentity(tenantId, request.params.id, request.authContext?.apiKeyId);

      return reply.send({
        message: 'Identidad fiscal eliminada exitosamente'
      });
    }
  );
};
