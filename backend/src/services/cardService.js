/**
 * Debit card management: list, block (temporary or permanent) and unblock.
 * State changes run only after confirmation through the action service.
 */

import { money } from '../lib/money.js';
import { notFound, unprocessable } from '../lib/errors.js';
import { maskNumber } from './common.js';
import { audit } from './auditService.js';

export const BLOCK_REASONS = ['lost', 'stolen', 'suspicious_activity', 'damaged', 'temporary'];
const PERMANENT = new Set(['lost', 'stolen', 'suspicious_activity', 'damaged']);
const STATUS_LABELS = { active: 'Active', temporarily_blocked: 'Temporarily blocked', blocked: 'Permanently blocked' };

function formatCard(c) {
  return {
    id: c.id,
    variant: c.variant,
    network: c.network,
    last4: c.last4,
    maskedNumber: `•••• •••• •••• ${c.last4}`,
    expiry: c.expiry,
    status: c.status,
    statusLabel: STATUS_LABELS[c.status],
    blockReason: c.block_reason,
    dailyLimit: money(c.daily_limit_paise),
    onlineEnabled: Boolean(c.online_enabled),
    internationalEnabled: Boolean(c.international_enabled),
    linkedAccount: { id: c.account_id, nickname: c.account_nickname, maskedNumber: maskNumber(c.account_number) }
  };
}

const CARD_SELECT = 'SELECT c.*, a.nickname AS account_nickname, a.account_number FROM cards c JOIN accounts a ON a.id = c.account_id';

export function listCards(db, userId) {
  return db.all(`${CARD_SELECT} WHERE c.user_id = :userId ORDER BY c.id`, { userId }).map(formatCard);
}

function resolveCard(db, userId, ref, statusFilter) {
  let rows = db.all(`${CARD_SELECT} WHERE c.user_id = :userId`, { userId });
  if (statusFilter) rows = rows.filter((c) => statusFilter.includes(c.status));
  if (!ref) return rows.length === 1 ? { status: 'resolved', card: rows[0] } : rows.length ? { status: 'ambiguous', candidates: rows } : { status: 'none' };
  const q = String(ref).toLowerCase();
  const digits = q.replace(/\D/g, '');
  const matches = rows.filter((c) => c.id === ref || (digits.length === 4 && c.last4 === digits) || c.variant.toLowerCase().includes(q) || c.account_nickname.toLowerCase().includes(q) || q.includes(c.network));
  if (matches.length === 1) return { status: 'resolved', card: matches[0] };
  if (matches.length > 1) return { status: 'ambiguous', candidates: matches };
  return { status: 'none' };
}

const cardOption = (c) => ({ label: `${c.variant} ••${c.last4} (${c.account_nickname})`, value: c.id });

export function prepareCardBlock(db, userId, { card, reason }) {
  const match = resolveCard(db, userId, card, ['active', 'temporarily_blocked']);
  if (match.status === 'ambiguous') return { status: 'needs_clarification', field: 'card', message: 'Which card should I block?', options: match.candidates.map(cardOption) };
  if (match.status === 'none') {
    const any = resolveCard(db, userId, card);
    if (any.status === 'resolved' && any.card.status === 'blocked') return { status: 'rejected', code: 'already_blocked', message: `Card ••${any.card.last4} is already permanently blocked.` };
    return { status: 'rejected', code: 'card_not_found', message: 'I could not find that card.' };
  }
  const c = match.card;
  const effectiveReason = reason ?? 'temporary';
  const permanent = PERMANENT.has(effectiveReason);
  if (c.status === 'temporarily_blocked' && !permanent) return { status: 'rejected', code: 'already_blocked', message: `Card ••${c.last4} is already temporarily blocked.` };
  return {
    status: 'ready',
    payload: { cardId: c.id, reason: effectiveReason },
    preview: {
      card: formatCard(c),
      reason: effectiveReason,
      permanent,
      consequence: permanent
        ? 'This permanently blocks the card. It cannot be unblocked; a replacement card can be requested.'
        : 'This temporarily blocks all card payments and ATM withdrawals. You can unblock it at any time.',
      simulated: true
    }
  };
}

export function executeCardBlock(db, userId, { cardId, reason }) {
  const c = db.get(`${CARD_SELECT} WHERE c.id = :cardId AND c.user_id = :userId`, { cardId, userId });
  if (!c) throw notFound('Card not found.');
  if (c.status === 'blocked') throw unprocessable('This card is already permanently blocked.', 'already_blocked');
  const status = PERMANENT.has(reason) ? 'blocked' : 'temporarily_blocked';
  db.run('UPDATE cards SET status = :status, block_reason = :reason, updated_at = :now WHERE id = :cardId', { status, reason, now: new Date().toISOString(), cardId });
  audit(db, { userId, event: 'card.blocked', resourceType: 'card', resourceId: cardId, details: { reason, status } });
  const updated = db.get(`${CARD_SELECT} WHERE c.id = :cardId`, { cardId });
  return { card: formatCard(updated), status: 'completed', message: `${c.variant} ••${c.last4} is now ${STATUS_LABELS[status].toLowerCase()}.`, simulated: true };
}

export function prepareCardUnblock(db, userId, { card }) {
  const match = resolveCard(db, userId, card, ['temporarily_blocked']);
  if (match.status === 'ambiguous') return { status: 'needs_clarification', field: 'card', message: 'Which card should I unblock?', options: match.candidates.map(cardOption) };
  if (match.status === 'none') {
    const any = resolveCard(db, userId, card);
    if (any.status === 'resolved' && any.card.status === 'blocked') return { status: 'rejected', code: 'permanently_blocked', message: `Card ••${any.card.last4} was permanently blocked (${any.card.block_reason}) and cannot be unblocked. You can request a replacement card.` };
    if (any.status === 'resolved' && any.card.status === 'active') return { status: 'rejected', code: 'not_blocked', message: `Card ••${any.card.last4} is already active.` };
    return { status: 'rejected', code: 'no_blocked_cards', message: 'None of your cards are temporarily blocked.' };
  }
  return { status: 'ready', payload: { cardId: match.card.id }, preview: { card: formatCard(match.card), consequence: 'Card payments and ATM withdrawals will work again.', simulated: true } };
}

export function executeCardUnblock(db, userId, { cardId }) {
  const c = db.get(`${CARD_SELECT} WHERE c.id = :cardId AND c.user_id = :userId`, { cardId, userId });
  if (!c) throw notFound('Card not found.');
  if (c.status !== 'temporarily_blocked') throw unprocessable('Only temporarily blocked cards can be unblocked.', 'not_unblockable');
  db.run(`UPDATE cards SET status = 'active', block_reason = NULL, updated_at = :now WHERE id = :cardId`, { now: new Date().toISOString(), cardId });
  audit(db, { userId, event: 'card.unblocked', resourceType: 'card', resourceId: cardId });
  const updated = db.get(`${CARD_SELECT} WHERE c.id = :cardId`, { cardId });
  return { card: formatCard(updated), status: 'completed', message: `${c.variant} ••${c.last4} is active again.`, simulated: true };
}
