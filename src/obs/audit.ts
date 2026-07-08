import { dbInsertAudit, type AuditEntry } from '../store/db';
import { inc } from './metrics';
import { redactPII } from './redact';
import { log } from '../log';

// Auditoría: registra en logs + Postgres (si está) + incrementa una métrica por tipo.
// El `detail` se redacta (email/teléfono) antes de loguear y persistir, para minimizar PII.
export async function audit(entry: AuditEntry): Promise<void> {
  inc(`audit:${entry.type}`);
  const safe: AuditEntry = {
    ...entry,
    detail: entry.detail !== undefined ? redactPII(entry.detail) : undefined,
  };
  log.info(`AUDIT ${entry.type}`, {
    dialogId: safe.dialogId,
    crmEntity: safe.crmEntity,
    detail: safe.detail,
  });
  await dbInsertAudit(safe);
}
