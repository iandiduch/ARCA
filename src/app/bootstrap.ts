import { createApp } from './server.js';
import { loadConfig } from './config.js';
import { logger } from './logger.js';
import { closeDatabaseConnection } from '../infrastructure/database/connection.js';

async function bootstrap() {
  const config = loadConfig();

  try {
    const app = await createApp({ enableLogging: true });

    await app.listen({
      port: config.PORT,
      host: config.HOST
    });

    const address = `http://${config.HOST === '0.0.0.0' ? 'localhost' : config.HOST}:${config.PORT}`;
    logger.info(`🚀 Servidor ARCA API escuchando en: ${address}`);
    logger.info(`📖 Documentación Swagger UI disponible en: ${address}/documentation`);

    // Manejo de apagado elegante (graceful shutdown)
    const gracefulShutdown = async (signal: string) => {
      logger.info(`Señal ${signal} recibida. Cerrando conexiones con gracia...`);
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
