/**
 * Accounts and balances. Available balance = ledger balance − pending debits (holds).
 */

import { money, sumPaise } from '../lib/money.js';
import { notFound } from '../lib/errors.js';
import { maskNumber } from './common.js';

const TYPE_LABELS = { savings: 'Savings account', current: 'Current account', fixed_deposit: 'Fixed deposit' };

export function getAccountRows(db, userId) {
  return db.all(`SELECT * FROM accounts WHERE user_id = :userId ORDER BY is_primary DESC, CASE type WHEN 'fixed_deposit' THEN 1 ELSE 0 END, nickname`, { userId });
}

export function accountsMap(db, userId) {
  return new Map(getAccountRows(db, userId).map((a) => [a.id, a]));
}

export function pendingHoldsPaise(db, accountId) {
  const row = db.get(`SELECT COALESCE(SUM(amount_paise), 0) AS holds FROM transactions
                      WHERE account_id = :accountId AND status = 'pending' AND direction = 'debit'`, { accountId });
  return row.holds;
}

export function availablePaise(db, account) {
  if (account.type === 'fixed_deposit') return 0;
  return Math.max(0, account.balance_paise - pendingHoldsPaise(db, account.id));
}

export function isTransactable(account) {
  return account.type !== 'fixed_deposit' && account.status === 'active';
}

export function formatAccount(db, a) {
  const holds = a.type === 'fixed_deposit' ? 0 : pendingHoldsPaise(db, a.id);
  return {
    id: a.id,
    type: a.type,
    typeLabel: TYPE_LABELS[a.type],
    nickname: a.nickname,
    maskedNumber: maskNumber(a.account_number),
    ifsc: a.ifsc,
    branch: a.branch,
    currency: a.currency,
    balance: money(a.balance_paise),
    availableBalance: money(a.type === 'fixed_deposit' ? 0 : Math.max(0, a.balance_paise - holds)),
    holds: money(holds),
    status: a.status,
    isPrimary: Boolean(a.is_primary),
    transactable: isTransactable(a),
    interestRatePct: a.interest_rate_bps / 100,
    maturityDate: a.maturity_date
  };
}

export function listAccounts(db, userId) {
  const accounts = getAccountRows(db, userId).map((a) => formatAccount(db, a));
  const deposits = sumPaise(accounts.map((a) => a.balance.paise));
  const available = sumPaise(accounts.map((a) => a.availableBalance.paise));
  return { accounts, totalBalance: money(deposits), totalAvailable: money(available), accountCount: accounts.length };
}

export function getAccountRow(db, userId, accountId) {
  const row = db.get('SELECT * FROM accounts WHERE id = :accountId AND user_id = :userId', { accountId, userId });
  if (!row) throw notFound('Account not found.');
  return row;
}

/**
 * Resolve a user-supplied account reference (id, last 4 digits, nickname or type)
 * to exactly one of the user's accounts.
 */
export function resolveAccount(db, userId, ref, { transactableOnly = false } = {}) {
  let rows = getAccountRows(db, userId);
  if (transactableOnly) rows = rows.filter(isTransactable);
  if (!ref) {
    const primary = rows.find((a) => a.is_primary) ?? rows[0];
    return primary ? { status: 'resolved', account: primary, defaulted: true } : { status: 'not_found' };
  }
  const q = String(ref).toLowerCase().replace(/[•*]/g, ' ').replace(/\bx+(?=\d)/g, ' ').replace(/\s+/g, ' ').trim();
  const digits = q.replace(/\D/g, '');
  const matches = rows.filter((a) => a.id === ref
    || (digits.length >= 4 && a.account_number.endsWith(digits))
    || a.nickname.toLowerCase().includes(q)
    || q.includes(a.nickname.toLowerCase())
    || a.type === q.replace(/\s+/g, '_')
    || (q.includes('fixed') && a.type === 'fixed_deposit')
    || (q === 'primary' && a.is_primary));
  if (matches.length === 1) return { status: 'resolved', account: matches[0], defaulted: false };
  if (matches.length > 1) return { status: 'ambiguous', candidates: matches };
  return { status: 'not_found' };
}
