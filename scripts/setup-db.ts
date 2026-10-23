import pg from 'pg';
import { runMigrations } from '../src/infrastructure/database/migrate.js';
import { closeDatabaseConnection } from '../src/infrastructure/database/connection.js';

const { Client } = pg;

async function setup() {
  const adminClient = new Client('postgres://postgres:Morado80@localhost:5432/postgres');
  await adminClient.connect();

  const check = await adminClient.query("SELECT 1 FROM pg_database WHERE datname = 'arca_db'");
  if (check.rows.length === 0) {
    console.log('Creando base de datos arca_db...');
    await adminClient.query('CREATE DATABASE arca_db');
    console.log('Base de datos arca_db creada exitosamente');
  } else {
    console.log('La base de datos arca_db ya existe');
  }
  await adminClient.end();

  console.log('Ejecutando migraciones en arca_db...');
  await runMigrations();
  await closeDatabaseConnection();
  console.log('Configuración de base de datos finalizada');
}

setup().catch((err) => {
  console.error('Error durante setup de base de datos:', err);
  process.exit(1);
});
