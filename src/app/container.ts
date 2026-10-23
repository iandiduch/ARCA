import { loadConfig, type AppConfig } from './config.js';
import { logger } from './logger.js';
import { getDatabase, getDatabasePool } from '../infrastructure/database/connection.js';
import type { Logger } from 'pino';
import type { Pool } from 'pg';

export interface ServiceContainer {
  config: AppConfig;
  logger: Logger;
  db: ReturnType<typeof getDatabase>;
  dbPool: Pool;
}

let containerInstance: ServiceContainer | null = null;

export function getContainer(): ServiceContainer {
  if (!containerInstance) {
    const config = loadConfig();
    const db = getDatabase();
    const dbPool = getDatabasePool();

    containerInstance = {
      config,
      logger,
      db,
      dbPool
    };
  }

  return containerInstance;
}
