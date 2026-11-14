/**
 * Append-only audit trail for security and financial events. Details are
 * redacted before storage; request ID and IP come from the request context.
 */

import { requestContext, redact, logger } from '../lib/logger.js';

export function audit(db, { userId, event, resourceType = null, resourceId = null, outcome = 'success', details = {} }) {
  const ctx = requestContext.getStore();
  db.run(`INSERT INTO audit_logs (user_id, event, resource_type, resource_id, outcome, details_json, request_id, ip, created_at)
          VALUES (:userId, :event, :resourceType, :resourceId, :outcome, :details, :requestId, :ip, :createdAt)`, {
    userId: userId ?? null,
    event,
    resourceType,
    resourceId,
    outcome,
    details: JSON.stringify(redact(details)),
    requestId: ctx?.requestId ?? null,
    ip: ctx?.ip ?? null,
    createdAt: new Date().toISOString()
  });
  logger.info('audit', { event, outcome, resourceType, resourceId });
}

export function listAuditLogs(db, userId, limit = 50) {
  return db.all('SELECT event, resource_type, resource_id, outcome, details_json, request_id, created_at FROM audit_logs WHERE user_id = :userId ORDER BY id DESC LIMIT :limit', { userId, limit })
    .map((r) => ({ ...r, details: JSON.parse(r.details_json), details_json: undefined }));
}
