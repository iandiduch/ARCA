import { getDatabase } from '../../../infrastructure/database/connection.js';
import { auditLogs, type NewAuditLog } from '../../../infrastructure/database/schema/audit-logs.js';
import { logger } from '../../../app/logger.js';
import { eq, desc } from 'drizzle-orm';

export interface RecordAuditParams {
  tenantId?: string | undefined;
  userId?: string | undefined;
  apiKeyId?: string | undefined;
  action: string;
  entityType: string;
  entityId?: string | undefined;
  payload?: unknown | undefined;
  ipAddress?: string | undefined;
}

export class AuditService {
  public static async record(params: RecordAuditParams): Promise<void> {
    try {
      const db = getDatabase();
      const newLog: NewAuditLog = {
        tenantId: params.tenantId,
        userId: params.userId,
        apiKeyId: params.apiKeyId,
        action: params.action,
        entityType: params.entityType,
        entityId: params.entityId,
        payload: params.payload,
        ipAddress: params.ipAddress
      };

      await db.insert(auditLogs).values(newLog);
    } catch (err) {
      // Un fallo en auditoría nunca debe voltear la transacción principal del usuario, pero debe registrarse en logs
      logger.error({ err, params }, 'Error al persistir registro de auditoría');
    }
  }

  public static async listByTenant(tenantId: string, limit = 50, offset = 0) {
    const db = getDatabase();
    return db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.tenantId, tenantId))
      .orderBy(desc(auditLogs.createdAt))
      .limit(limit)
      .offset(offset);
  }
}
