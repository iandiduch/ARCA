import 'dotenv/config';
import { z } from 'zod';

const DEFAULT_DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/arca_db';

export const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.string().url().default(DEFAULT_DATABASE_URL),
  DATABASE_MAX_CONNECTIONS: z.coerce.number().default(10),
  API_KEY_MASTER: z.string().min(16).default('dev-master-secret-key-change-in-production'),
  ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY debe tener 64 caracteres hexadecimales (openssl rand -hex 32)')
    .default('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'),
  ARCA_DEFAULT_ENVIRONMENT: z.enum(['homologation', 'production']).default('homologation'),
  ARCA_PLATFORM_CUIT: z.string().regex(/^\d{11}$/).default('20000000001'),
  RATE_LIMIT_MAX: z.coerce.number().default(300),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60000),
  CORS_ORIGIN: z.string().default('*'),
  // Saltos de proxy inverso confiables para tomar la IP real de X-Forwarded-For ("1" detrás de Traefik)
  TRUST_PROXY: z.string().default('false'),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().default(10000),
  // Pool separado para los bloqueos de secuencia fiscal / WSAA: no compite con las consultas normales
  DATABASE_LOCK_MAX_CONNECTIONS: z.coerce.number().int().min(1).default(10),
  // Espera máxima para obtener el turno de emisión de un punto de venta antes de responder 503
  FISCAL_LOCK_TIMEOUT_MS: z.coerce.number().int().min(100).default(30000),
  // Máximo de emisiones en vuelo simultáneas por comercio antes de responder 503/429
  MAX_IN_FLIGHT_EMISSIONS_PER_TENANT: z.coerce.number().int().min(1).default(5),
  // Máximo de peticiones encoladas en proceso por secuencia fiscal antes de rechazo inmediato
  MAX_QUEUE_PER_SEQUENCE: z.coerce.number().int().min(1).default(10),
  // Swagger UI en /documentation. Por defecto deshabilitado en producción
  DOCS_ENABLED: z.enum(['true', 'false']).optional(),
  // Envío de comprobantes por email (sin SMTP_HOST, en producción el endpoint responde 503)
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_SECURE: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  // Máximo de envíos del mismo comprobante en 24 h (evita usar la API como relay de spam)
  EMAIL_MAX_SENDS_PER_INVOICE: z.coerce.number().int().min(1).default(5)
}).superRefine((data, ctx) => {
  if (data.SMTP_HOST && !data.SMTP_FROM && !data.SMTP_USER) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['SMTP_FROM'],
      message: 'Con SMTP_HOST configurado se requiere SMTP_FROM (o SMTP_USER) como remitente.'
    });
  }

  if (data.NODE_ENV === 'production') {
    if (data.API_KEY_MASTER === 'dev-master-secret-key-change-in-production') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['API_KEY_MASTER'],
        message: 'En entorno de producción (NODE_ENV=production), API_KEY_MASTER debe ser configurada con una clave secreta real y no el valor por defecto de desarrollo.'
      });
    }

    if (data.API_KEY_MASTER.length < 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['API_KEY_MASTER'],
        message: 'En producción API_KEY_MASTER debe tener al menos 32 caracteres (openssl rand -hex 32).'
      });
    }

    if (data.DATABASE_URL === DEFAULT_DATABASE_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DATABASE_URL'],
        message: 'En producción DATABASE_URL debe configurarse explícitamente (no se admite el valor por defecto de desarrollo).'
      });
    }

    if (data.ENCRYPTION_KEY === '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ENCRYPTION_KEY'],
        message: 'En entorno de producción (NODE_ENV=production), ENCRYPTION_KEY debe ser una clave criptográfica real de 64 caracteres hex y no el valor por defecto de desarrollo.'
      });
    }
  }
});

export type AppConfig = z.infer<typeof envSchema>;

let cachedConfig: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const errorDetails = result.error.issues
      .map((e) => `[${e.path.join('.')}] ${e.message}`)
      .join(', ');
    throw new Error(`Configuración de entorno inválida: ${errorDetails}`);
  }

  cachedConfig = result.data;
  return cachedConfig;
}
