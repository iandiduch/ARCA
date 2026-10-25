import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import pg from 'pg';
import { loadConfig } from '../src/app/config.js';

const config = loadConfig();

const TABLES_IN_INSERT_ORDER = [
  'tenants',
  'users',
  'tenant_memberships',
  'api_keys',
  'audit_logs',
  'customers',
  'products',
  'fiscal_identities',
  'fiscal_certificates',
  'points_of_sale',
  'wsaa_access_tickets',
  'invoices',
  'invoice_items',
  'invoice_vat_subtotals',
  'invoice_associated_vouchers',
  'idempotency_keys'
];

export async function restoreDatabase(backupFilePath: string): Promise<{
  restoredTables: Record<string, number>;
  sourceTimestamp: string;
}> {
  if (!fs.existsSync(backupFilePath)) {
    throw new Error(`El archivo de backup no existe: "${backupFilePath}"`);
  }

  const raw = fs.readFileSync(backupFilePath, 'utf-8');
  const checksum = crypto.createHash('sha256').update(raw).digest('hex');
  const snapshot = JSON.parse(raw);

  if (!snapshot.metadata || !snapshot.tables) {
    throw new Error('El archivo no tiene una estructura válida de snapshot de base de datos');
  }

  const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Desactivar temporalmente disparadores de integridad para truncado y carga limpia
    await client.query('SET session_replication_role = replica');

    // 1. Truncar tablas en orden inverso
    const reverseTables = [...TABLES_IN_INSERT_ORDER].reverse();
    for (const table of reverseTables) {
      await client.query(`TRUNCATE TABLE "${table}" CASCADE`);
    }

    const restoredCounts: Record<string, number> = {};

    // 2. Insertar registros en orden directo
    for (const table of TABLES_IN_INSERT_ORDER) {
      const rows = snapshot.tables[table] || [];
      restoredCounts[table] = 0;

      if (rows.length > 0) {
        for (const row of rows) {
          const columns = Object.keys(row);
          const values = Object.values(row).map((v) =>
            typeof v === 'object' && v !== null && !(v instanceof Date) ? JSON.stringify(v) : v
          );

          const colList = columns.map((c) => `"${c}"`).join(', ');
          const paramPlaceholders = values.map((_, idx) => `$${idx + 1}`).join(', ');

          const query = `INSERT INTO "${table}" (${colList}) VALUES (${paramPlaceholders})`;
          await client.query(query, values);
          restoredCounts[table]++;
        }
      }
    }

    // Reactivar integridad referencial normal
    await client.query('SET session_replication_role = DEFAULT');

    await client.query('COMMIT');

    return {
      restoredTables: restoredCounts,
      sourceTimestamp: snapshot.metadata.timestamp
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

// Ejecución directa via CLI
if (process.argv[1]?.endsWith('restore-db.ts')) {
  const fileArg = process.argv[2];
  if (!fileArg) {
    console.error('Uso: npx tsx scripts/restore-db.ts <ruta-al-archivo-backup.json>');
    process.exit(1);
  }

  const resolved = path.resolve(process.cwd(), fileArg);
  console.log(`Iniciando restauración desde ${resolved}...`);

  restoreDatabase(resolved)
    .then((res) => {
      console.log('✓ Restauración completada exitosamente.');
      console.log(`  Timestamp original: ${res.sourceTimestamp}`);
      console.log('  Filas restauradas por tabla:');
      for (const [table, count] of Object.entries(res.restoredTables)) {
        console.log(`    - ${table.padEnd(28)}: ${count} filas`);
      }
      process.exit(0);
    })
    .catch((err) => {
      console.error('✗ Error restaurando base de datos:', err);
      process.exit(1);
    });
}
