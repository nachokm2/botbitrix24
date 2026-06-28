import { dbInsertAudit, type AuditEntry } from '../store/db';
import { inc } from './metrics';
import { log } from '../log';

// Auditoría: registra en logs + Postgres (si está) + incrementa una métrica por tipo.
export async function audit(entry: AuditEntry): Promise<void> {
  inc(`audit:${entry.type}`);
  log.info(`AUDIT ${entry.type}`, {
    dialogId: entry.dialogId,
    crmEntity: entry.crmEntity,
    detail: entry.detail,
  });
  await dbInsertAudit(entry);
}
