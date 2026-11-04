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
    if (app.hasRoute({ method: 'GET', url: '/documentation' })) {
      logger.info(`📖 Documentación Swagger UI disponible en: ${address}/documentation`);
    }

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
    let shuttingDown = false;
    const gracefulShutdown = async (reason: string, exitCode: number) => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info(`${reason}. Cerrando conexiones con gracia...`);
      clearInterval(purgeTimer);

      // Si algo queda colgado (p. ej. una llamada a ARCA en curso), no bloquear el reinicio del contenedor
      const forceExit = setTimeout(() => {
        logger.error('El apagado excedió 10 s; se fuerza la salida');
        process.exit(exitCode || 1);
      }, 10000);
      forceExit.unref();

      try {
        await app.close();
        await closeDatabaseConnection();
        logger.info('Servidor y conexiones finalizados con éxito');
        process.exit(exitCode);
      } catch (err) {
        logger.error({ err }, 'Error durante el apagado del servidor');
        process.exit(1);
      }
    };

    process.on('SIGINT', () => void gracefulShutdown('Señal SIGINT recibida', 0));
    process.on('SIGTERM', () => void gracefulShutdown('Señal SIGTERM recibida', 0));

    // Un error no controlado deja el proceso en estado incierto: registrarlo y reiniciar de forma ordenada
    process.on('unhandledRejection', (reason) => {
      logger.fatal({ err: reason }, 'Promesa rechazada sin manejar');
      void gracefulShutdown('Promesa rechazada sin manejar', 1);
    });
    process.on('uncaughtException', (err) => {
      logger.fatal({ err }, 'Excepción no controlada');
      void gracefulShutdown('Excepción no controlada', 1);
    });
  } catch (err) {
    logger.fatal({ err }, 'Fallo crítico al iniciar el servidor ARCA API');
    await closeDatabaseConnection();
    process.exit(1);
  }
}

void bootstrap();
