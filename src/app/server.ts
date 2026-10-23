import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { errorHandler } from '../core/errors/error-handler.js';
import { healthRoutes } from './routes/health.js';
import { tenantRoutes } from '../modules/tenants/presentation/tenant-routes.js';
import { auditRoutes } from '../modules/audit/presentation/audit-routes.js';
import { customerRoutes } from '../modules/customers/presentation/customer-routes.js';
import { productRoutes } from '../modules/products/presentation/product-routes.js';
import { fiscalIdentityRoutes } from '../modules/fiscal-identities/presentation/fiscal-identity-routes.js';
import { invoiceRoutes } from '../modules/invoices/presentation/invoice-routes.js';
import { documentRoutes } from '../modules/documents/presentation/document-routes.js';
import { logger } from './logger.js';
import { getContainer, type ServiceContainer } from './container.js';

export interface CreateAppOptions {
  container?: ServiceContainer;
  enableLogging?: boolean;
}

export async function createApp(options?: CreateAppOptions): Promise<FastifyInstance> {
  const container = options?.container || getContainer();
  const config = container.config;

  const fastifyOptions: FastifyServerOptions = {};

  if (options?.enableLogging !== false) {
    fastifyOptions.loggerInstance = logger;
  }

  const app = Fastify(fastifyOptions).withTypeProvider<TypeBoxTypeProvider>();

  // Manejo global de errores
  app.setErrorHandler((error, request, reply) => {
    return errorHandler(error as Error, request, reply);
  });

  // Seguridad y cabeceras
  await app.register(helmet, {
    contentSecurityPolicy: config.NODE_ENV === 'production'
  });

  await app.register(cors, {
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
  });

  // Documentación OpenAPI / Swagger
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'API de Facturación Electrónica ARCA (ex-AFIP)',
        description:
          'API REST multi-tenant para emisión de comprobantes fiscales, autenticación WSAA, WSFEv1 y gestión de identidades fiscales.',
        version: '0.1.0'
      },
      servers: [
        {
          url: `http://${config.HOST === '0.0.0.0' ? 'localhost' : config.HOST}:${config.PORT}`,
          description: 'Servidor Local / VPS'
        }
      ],
      components: {
        securitySchemes: {
          apiKeyAuth: {
            type: 'apiKey',
            name: 'x-api-key',
            in: 'header',
            description: 'API Key del comercio o clave maestra de administración'
          }
        }
      },
      tags: [
        { name: 'Health', description: 'Monitoreo de estado y dependencias' },
        { name: 'Tenants', description: 'Gestión de comercios y API Keys multi-tenant' },
        { name: 'Audit', description: 'Pistas y registros de auditoría' },
        { name: 'Invoices', description: 'Emisión y consulta de facturas y notas' },
        { name: 'Fiscal Identities', description: 'Vinculación de comercios con ARCA' },
        { name: 'Taxpayer Registry', description: 'Consulta al padrón oficial de ARCA' },
        { name: 'Catalogs', description: 'Tablas de parámetros fiscales' }
      ]
    }
  });

  await app.register(swaggerUi, {
    routePrefix: '/documentation',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true
    }
  });

  // Rutas base
  await app.register(healthRoutes);

  // Rutas de Multi-tenancy y Auditoría
  await app.register(tenantRoutes);
  await app.register(auditRoutes);

  // Rutas de Catálogos Comerciales (Clientes y Productos)
  await app.register(customerRoutes);
  await app.register(productRoutes);

  // Rutas de Integración ARCA e Identidades Fiscales
  await app.register(fiscalIdentityRoutes);

  // Rutas de Facturación Electrónica (Fase 5)
  await app.register(invoiceRoutes);

  // Rutas de Documentos, Impresión Térmica, QR y Notificaciones (Fase 6)
  await app.register(documentRoutes);

  // Ruta raíz informativa
  app.get('/', async (_req, reply) => {
    return reply.send({
      name: 'ARCA Fiscal API',
      version: '0.1.0',
      environment: config.ARCA_DEFAULT_ENVIRONMENT,
      documentation: '/documentation',
      health: {
        liveness: '/health/live',
        readiness: '/health/ready'
      }
    });
  });

  return app as unknown as FastifyInstance;
}
