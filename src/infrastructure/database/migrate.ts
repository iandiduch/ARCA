import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { getDatabase, closeDatabaseConnection } from './connection.js';
import { logger } from '../../app/logger.js';

export async function runMigrations() {
  logger.info('Iniciando ejecución de migraciones de base de datos...');
  const db = getDatabase();

  try {
    await migrate(db, { migrationsFolder: './drizzle' });
    logger.info('Migraciones ejecutadas exitosamente');
  } catch (err) {
    logger.error({ err }, 'Error crítico al ejecutar migraciones de base de datos');
    throw err;
  }
}

// Ejecución directa si se invoca como script CLI
if (process.argv[1]?.endsWith('migrate.ts') || process.argv[1]?.endsWith('migrate.js')) {
  runMigrations()
    .then(async () => {
      await closeDatabaseConnection();
      process.exit(0);
    })
    .catch(async () => {
      await closeDatabaseConnection();
      process.exit(1);
    });
}
