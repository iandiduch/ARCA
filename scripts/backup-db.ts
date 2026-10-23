import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import pg from 'pg';
import { loadConfig } from '../src/app/config.js';

const config = loadConfig();

const TABLES_IN_ORDER = [
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

export async function backupDatabase(targetDir?: string): Promise<{
  backupPath: string;
  tableCounts: Record<string, number>;
  checksum: string;
}> {
  const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
  const client = await pool.connect();

  const backupDir = targetDir || path.resolve(process.cwd(), 'backups');
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFileName = `backup_${timestamp}.json`;
  const backupPath = path.join(backupDir, backupFileName);

  const snapshot: {
    metadata: {
      timestamp: string;
      version: string;
      nodeVersion: string;
      tableCounts: Record<string, number>;
    };
    tables: Record<string, unknown[]>;
  } = {
    metadata: {
      timestamp: new Date().toISOString(),
      version: '1.0.0',
      nodeVersion: process.version,
      tableCounts: {}
    },
    tables: {}
  };

  try {
    for (const table of TABLES_IN_ORDER) {
      // Verificar si la tabla existe en PostgreSQL
      const checkExists = await client.query(
        `SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = $1
        )`,
        [table]
      );

      if (checkExists.rows[0].exists) {
        const result = await client.query(`SELECT * FROM "${table}"`);
        snapshot.tables[table] = result.rows;
        snapshot.metadata.tableCounts[table] = result.rows.length;
      } else {
        snapshot.tables[table] = [];
        snapshot.metadata.tableCounts[table] = 0;
      }
    }

    const jsonContent = JSON.stringify(snapshot, null, 2);
    const checksum = crypto.createHash('sha256').update(jsonContent).digest('hex');

    fs.writeFileSync(backupPath, jsonContent, 'utf-8');

    return {
      backupPath,
      tableCounts: snapshot.metadata.tableCounts,
      checksum
    };
  } finally {
    client.release();
    await pool.end();
  }
}

// Ejecución directa via CLI
if (process.argv[1]?.endsWith('backup-db.ts')) {
  backupDatabase()
    .then((res) => {
      console.log('✓ Backup de base de datos generado con éxito:');
      console.log(`  Archivo:  ${res.backupPath}`);
      console.log(`  SHA256:   ${res.checksum}`);
      console.log('  Tablas respaldadas:');
      for (const [table, count] of Object.entries(res.tableCounts)) {
        console.log(`    - ${table.padEnd(28)}: ${count} filas`);
      }
      process.exit(0);
    })
    .catch((err) => {
      console.error('✗ Error generando backup:', err);
      process.exit(1);
    });
}
