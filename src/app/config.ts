import 'dotenv/config';
import { z } from 'zod';

export const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.string().url().default('postgres://postgres:postgres@localhost:5432/arca_db'),
  DATABASE_MAX_CONNECTIONS: z.coerce.number().default(10),
  API_KEY_MASTER: z.string().min(16).default('dev-master-secret-key-change-in-production'),
  ENCRYPTION_KEY: z.string().length(64).default('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'),
  ARCA_DEFAULT_ENVIRONMENT: z.enum(['homologation', 'production']).default('homologation'),
  ARCA_PLATFORM_CUIT: z.string().regex(/^\d{11}$/).default('20000000001'),
  RATE_LIMIT_MAX: z.coerce.number().default(300),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60000),
  CORS_ORIGIN: z.string().default('*'),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().default(10000)
}).superRefine((data, ctx) => {
  if (data.NODE_ENV === 'production') {
    if (data.API_KEY_MASTER === 'dev-master-secret-key-change-in-production') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['API_KEY_MASTER'],
        message: 'En entorno de producción (NODE_ENV=production), API_KEY_MASTER debe ser configurada con una clave secreta real y no el valor por defecto de desarrollo.'
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
    const errorDetails = result.error.errors
      .map((e) => `[${e.path.join('.')}] ${e.message}`)
      .join(', ');
    throw new Error(`Configuración de entorno inválida: ${errorDetails}`);
  }

  cachedConfig = result.data;
  return cachedConfig;
}
