/**
 * Pending actions: the only path by which money moves or account state changes.
 *
 *   prepare (tool or UI) ──> pending_actions row (status=pending, TTL 5 min)
 *   user presses Confirm ──> confirmAction() ──> executor (atomic) ──> completed
 *
 * Guarantees:
 *  - Ownership: actions are looked up by (id, user_id).
 *  - Idempotency: confirming a completed action returns the stored receipt
 *    (replayed=true) and never executes twice; transfers.action_id is UNIQUE.
 *  - Dedupe: preparing an identical action while one is pending reuses it.
 *  - Expiry: actions older than the TTL cannot be confirmed.
 *  - Authorization: each action type requires a permission scope.
 */

import { conflict, forbidden, notFound } from '../lib/errors.js';
import { canonicalJson, newId, sha256 } from './common.js';
import { audit } from './auditService.js';
import { hasScope } from './authService.js';
import { executeTransfer } from './transferService.js';
import { executeBillPayment } from './billService.js';
import { executeCardBlock, executeCardUnblock } from './cardService.js';
import { executeAddBeneficiary } from './beneficiaryService.js';
import { AppError } from '../lib/errors.js';

export const ACTION_TTL_MS = 5 * 60_000;

export const ACTION_TYPES = {
  transfer: { scope: 'payments:write', title: 'Transfer money', execute: executeTransfer },
  bill_payment: { scope: 'payments:write', title: 'Pay bill', execute: executeBillPayment },
  card_block: { scope: 'cards:write', title: 'Block card', execute: (db, userId, p) => executeCardBlock(db, userId, p) },
  card_unblock: { scope: 'cards:write', title: 'Unblock card', execute: (db, userId, p) => executeCardUnblock(db, userId, p) },
  add_beneficiary: { scope: 'beneficiaries:write', title: 'Add beneficiary', execute: (db, userId, p) => executeAddBeneficiary(db, userId, p) }
};

function formatAction(row) {
  return {
    id: row.id,
    type: row.type,
    title: ACTION_TYPES[row.type].title,
    status: row.status,
    preview: JSON.parse(row.preview_json),
    result: row.result_json ? JSON.parse(row.result_json) : null,
    error: row.error_message,
    expiresAt: row.expires_at,
    createdAt: row.created_at
  };
}

function expireStale(db, userId) {
  db.run(`UPDATE pending_actions SET status = 'expired', resolved_at = :now WHERE user_id = :userId AND status = 'pending' AND expires_at < :now`, { userId, now: new Date().toISOString() });
}

export function assertActionScope(user, type) {
  const def = ACTION_TYPES[type];
  if (!def) throw forbidden('Unsupported action.');
  if (!hasScope(user, def.scope)) {
    throw forbidden('Your profile has read-only access, so this action is not allowed.');
  }
}

/** Store a prepared ("ready") action and return it. Reuses an identical pending action. */
export function createPendingAction(db, user, { type, payload, preview, conversationId = null }) {
  assertActionScope(user, type);
  expireStale(db, user.id);
  const fingerprint = sha256(`${type}:${canonicalJson(payload)}`);
  const existing = db.get(`SELECT * FROM pending_actions WHERE user_id = :userId AND fingerprint = :fingerprint AND status = 'pending'`, { userId: user.id, fingerprint });
  if (existing) {
    // Refresh the preview (balances may have changed) but keep the same id: a double prepare yields one action.
    db.run('UPDATE pending_actions SET preview_json = :preview WHERE id = :id', { id: existing.id, preview: JSON.stringify(preview) });
    return { ...formatAction({ ...existing, preview_json: JSON.stringify(preview) }), reused: true };
  }
  const now = new Date();
  const row = {
    id: newId('act'),
    user_id: user.id,
    conversation_id: conversationId,
    type,
    payload_json: JSON.stringify(payload),
    preview_json: JSON.stringify(preview),
    fingerprint,
    status: 'pending',
    expires_at: new Date(now.getTime() + ACTION_TTL_MS).toISOString(),
    created_at: now.toISOString()
  };
  db.run(`INSERT INTO pending_actions (id, user_id, conversation_id, type, payload_json, preview_json, fingerprint, status, expires_at, created_at)
          VALUES (:id, :user_id, :conversation_id, :type, :payload_json, :preview_json, :fingerprint, :status, :expires_at, :created_at)`, row);
  audit(db, { userId: user.id, event: 'action.prepared', resourceType: 'action', resourceId: row.id, details: { type } });
  return { ...formatAction(row), reused: false };
}

export function getAction(db, userId, actionId) {
  expireStale(db, userId);
  const row = db.get('SELECT * FROM pending_actions WHERE id = :actionId AND user_id = :userId', { actionId, userId });
  if (!row) throw notFound('This request was not found or has expired.');
  return formatAction(row);
}

export function listPendingActions(db, userId) {
  expireStale(db, userId);
  return db.all(`SELECT * FROM pending_actions WHERE user_id = :userId AND status = 'pending' ORDER BY created_at DESC`, { userId }).map(formatAction);
}

export function confirmAction(db, user, actionId) {
  const row = db.get('SELECT * FROM pending_actions WHERE id = :actionId AND user_id = :userId', { actionId, userId: user.id });
  if (!row) {
    audit(db, { userId: user.id, event: 'action.confirm', resourceType: 'action', resourceId: actionId, outcome: 'denied', details: { reason: 'not_found_or_not_owner' } });
    throw notFound('This request was not found or has expired.');
  }
  if (row.status === 'completed') return { ...formatAction(row), replayed: true };
  if (row.status !== 'pending') throw conflict(`This request is ${row.status} and can no longer be confirmed.`, { status: row.status });
  if (row.expires_at < new Date().toISOString()) {
    db.run(`UPDATE pending_actions SET status = 'expired', resolved_at = :now WHERE id = :id`, { id: row.id, now: new Date().toISOString() });
    throw conflict('This request expired. Please start again to get a fresh preview.', { status: 'expired' });
  }
  try {
    assertActionScope(user, row.type);
  } catch (error) {
    audit(db, { userId: user.id, event: 'action.confirm', resourceType: 'action', resourceId: row.id, outcome: 'denied', details: { type: row.type } });
    throw error;
  }

  const def = ACTION_TYPES[row.type];
  try {
    const result = db.transaction(() => {
      // Claim the action atomically; if another request already claimed it, no rows change.
      const claim = db.run(`UPDATE pending_actions SET status = 'completed', resolved_at = :now WHERE id = :id AND status = 'pending'`, { id: row.id, now: new Date().toISOString() });
      if (claim.changes !== 1) throw conflict('This request is already being processed.');
      const receipt = def.execute(db, user.id, JSON.parse(row.payload_json), row.id);
      db.run('UPDATE pending_actions SET result_json = :result WHERE id = :id', { id: row.id, result: JSON.stringify(receipt) });
      return receipt;
    });
    return { ...formatAction({ ...row, status: 'completed', result_json: JSON.stringify(result) }), replayed: false };
  } catch (error) {
    // The executor's changes were rolled back. Record the failure outside that transaction.
    const message = error instanceof AppError ? error.message : 'The action could not be completed. No money was moved.';
    db.run(`UPDATE pending_actions SET status = 'failed', error_message = :message, resolved_at = :now WHERE id = :id AND status = 'pending'`, { id: row.id, message, now: new Date().toISOString() });
    audit(db, { userId: user.id, event: `action.${row.type}`, resourceType: 'action', resourceId: row.id, outcome: 'failure', details: { code: error.code ?? 'internal' } });
    throw error;
  }
}

export function cancelAction(db, user, actionId) {
  const row = db.get('SELECT * FROM pending_actions WHERE id = :actionId AND user_id = :userId', { actionId, userId: user.id });
  if (!row) throw notFound('This request was not found or has expired.');
  if (row.status === 'cancelled') return formatAction(row);
  if (row.status !== 'pending') throw conflict(`This request is ${row.status} and can no longer be cancelled.`);
  db.run(`UPDATE pending_actions SET status = 'cancelled', resolved_at = :now WHERE id = :id AND status = 'pending'`, { id: row.id, now: new Date().toISOString() });
  audit(db, { userId: user.id, event: 'action.cancelled', resourceType: 'action', resourceId: row.id, details: { type: row.type } });
  return formatAction({ ...row, status: 'cancelled' });
}
