/**
 * @file backend/src/services/confirmationService.js
 * @description In-memory store for pending sensitive actions requiring explicit user approval.
 * Assigns one-time cryptographic UUIDs (`confirmationId`), enforces a 5-minute time-to-live (TTL),
 * links actions to authenticated user IDs, and provides replay attack protection by deleting
 * confirmation records prior to execution.
 */

import { randomUUID } from 'node:crypto';
import * as bank from './bankingService.js';

const pendingActions = new Map();
const ACTION_TTL_MS = 5 * 60 * 1000;

function cleanExpiredActions() {
  const cutoff = Date.now() - ACTION_TTL_MS;
  for (const [id, action] of pendingActions.entries()) {
    if (action.createdAt < cutoff) pendingActions.delete(id);
  }
}

export function createPendingActions(actions, userId) {
  cleanExpiredActions();
  return actions.map((action) => {
    const confirmationId = randomUUID();
    pendingActions.set(confirmationId, { ...action, confirmationId, userId, createdAt: Date.now() });
    return { confirmationId, ...action };
  });
}

export function resolvePendingAction({ confirmationId, approved, userId }) {
  cleanExpiredActions();
  const action = pendingActions.get(confirmationId);
  if (!action || action.userId !== userId) {
    const error = new Error('This confirmation has expired or is no longer available.');
    error.statusCode = 404;
    throw error;
  }
  // Delete before execution to prevent replay, even if execution fails.
  pendingActions.delete(confirmationId);
  if (!approved) return { status: 'cancelled', message: 'The action was cancelled. No banking data was changed.' };

  let result;
  if (action.type === 'transfer') result = bank.executeTransfer(action);
  else if (action.type === 'block_card') result = bank.executeBlockCard();
  else throw new Error('Unsupported sensitive action.');
  return { status: 'completed', actionType: action.type, result };
}
