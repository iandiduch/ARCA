import { createApp } from './server.js';
import { loadConfig } from './config.js';
import { logger } from './logger.js';
import { closeDatabaseConnection } from '../infrastructure/database/connection.js';
import { runMigrations } from '../infrastructure/database/migrate.js';
import { IdempotencyService } from '../core/security/idempotency-service.js';

async function bootstrap() {
  const config = loadConfig();

  try {
    // 1. Ejecutar migraciones automáticas al iniciar
    await runMigrations();

    const app = await createApp({ enableLogging: true });

    await app.listen({
      port: config.PORT,
      host: config.HOST
    });

    const address = `http://${config.HOST === '0.0.0.0' ? 'localhost' : config.HOST}:${config.PORT}`;
    logger.info(`🚀 Servidor ARCA API escuchando en: ${address}`);
    logger.info(`📖 Documentación Swagger UI disponible en: ${address}/documentation`);

    // Limpieza periódica de claves de idempotencia vencidas
    const purgeIdempotency = () =>
      IdempotencyService.purgeExpired()
        .then((count) => {
          if (count > 0) logger.info({ count }, 'Claves de idempotencia vencidas eliminadas');
        })
        .catch((err: unknown) => logger.warn({ err }, 'Error al purgar claves de idempotencia vencidas'));
    const purgeTimer = setInterval(() => void purgeIdempotency(), 60 * 60 * 1000);
    purgeTimer.unref();
    void purgeIdempotency();

    // Manejo de apagado elegante (graceful shutdown)
    const gracefulShutdown = async (signal: string) => {
      logger.info(`Señal ${signal} recibida. Cerrando conexiones con gracia...`);
      clearInterval(purgeTimer);
      try {
        await app.close();
        await closeDatabaseConnection();
        logger.info('Servidor y conexiones finalizados con éxito');
        process.exit(0);
      } catch (err) {
        logger.error({ err }, 'Error durante el apagado del servidor');
        process.exit(1);
      }
    };

    process.on('SIGINT', () => void gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
  } catch (err) {
    logger.fatal({ err }, 'Fallo crítico al iniciar el servidor ARCA API');
    await closeDatabaseConnection();
    process.exit(1);
  }
}

void bootstrap();
