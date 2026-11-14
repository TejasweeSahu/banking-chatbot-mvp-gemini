/**
 * Transaction history, search/filtering, explanations and anomaly detection.
 * All queries are scoped by user_id; callers can never read another user's ledger.
 */

import { money, sumPaise } from '../lib/money.js';
import { notFound } from '../lib/errors.js';
import { addDays, daysBetween, resolvePeriod, today } from '../lib/dates.js';
import { accountsMap } from './accountService.js';
import { expenseCategoryIds, formatTransaction, formatCategory } from './common.js';

const SORTS = {
  date_desc: 'posted_at DESC, id DESC',
  date_asc: 'posted_at ASC, id ASC',
  amount_desc: 'amount_paise DESC, posted_at DESC',
  amount_asc: 'amount_paise ASC, posted_at DESC'
};

export function resolveRange({ period, startDate, endDate } = {}) {
  if (startDate || endDate) {
    return { startDate: startDate ?? '1970-01-01', endDate: endDate ?? today(), label: `${startDate ?? 'start'} to ${endDate ?? today()}` };
  }
  return period ? resolvePeriod(period) : null;
}

/**
 * Filters (all optional): query, merchant, category, direction, status, channel,
 * minAmountPaise, maxAmountPaise, period | startDate/endDate, accountId, sort, limit, offset.
 */
export function searchTransactions(db, userId, filters = {}) {
  const where = ['user_id = :userId'];
  const params = { userId };
  const range = resolveRange(filters);
  if (range) {
    where.push('date BETWEEN :startDate AND :endDate');
    Object.assign(params, { startDate: range.startDate, endDate: range.endDate });
  }
  if (filters.query) {
    where.push("(description LIKE :q ESCAPE '\\' OR merchant LIKE :q ESCAPE '\\' OR reference = :exactRef)");
    params.q = `%${escapeLike(filters.query)}%`;
    params.exactRef = filters.query;
  }
  if (filters.merchant) {
    where.push("merchant LIKE :merchant ESCAPE '\\'");
    params.merchant = `%${escapeLike(filters.merchant)}%`;
  }
  for (const [key, column] of [['category', 'category_id'], ['direction', 'direction'], ['status', 'status'], ['channel', 'channel'], ['accountId', 'account_id']]) {
    if (filters[key]) {
      where.push(`${column} = :${key}`);
      params[key] = filters[key];
    }
  }
  if (filters.minAmountPaise != null) {
    where.push('amount_paise >= :minAmount');
    params.minAmount = filters.minAmountPaise;
  }
  if (filters.maxAmountPaise != null) {
    where.push('amount_paise <= :maxAmount');
    params.maxAmount = filters.maxAmountPaise;
  }
  const whereSql = where.join(' AND ');
  const limit = Math.min(filters.limit ?? 20, 100);
  const offset = filters.offset ?? 0;
  const rows = db.all(`SELECT * FROM transactions WHERE ${whereSql} ORDER BY ${SORTS[filters.sort] ?? SORTS.date_desc} LIMIT :limit OFFSET :offset`, { ...params, limit, offset });
  const agg = db.get(`SELECT COUNT(*) AS n,
      COALESCE(SUM(CASE WHEN direction = 'debit' AND status = 'success' THEN amount_paise END), 0) AS debits,
      COALESCE(SUM(CASE WHEN direction = 'credit' AND status = 'success' THEN amount_paise END), 0) AS credits
    FROM transactions WHERE ${whereSql}`, params);
  const accounts = accountsMap(db, userId);
  return {
    items: rows.map((r) => formatTransaction(db, r, accounts)),
    total: agg.n,
    returned: rows.length,
    hasMore: offset + rows.length < agg.n,
    range: range ?? null,
    totals: { successfulDebits: money(agg.debits), successfulCredits: money(agg.credits) }
  };
}

function escapeLike(text) {
  return String(text).replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function getTransactionRow(db, userId, transactionId) {
  const row = db.get('SELECT * FROM transactions WHERE id = :transactionId AND user_id = :userId', { transactionId, userId });
  if (!row) throw notFound('Transaction not found.');
  return row;
}

/** Find a transaction by internal id or bank reference number. */
export function findTransaction(db, userId, idOrReference) {
  const row = db.get('SELECT * FROM transactions WHERE user_id = :userId AND (id = :ref OR reference = :ref)', { userId, ref: idOrReference });
  if (!row) throw notFound('I could not find that transaction on your accounts.');
  return row;
}

const STATUS_GUIDANCE = {
  success: 'The transaction completed successfully and is reflected in your balance.',
  pending: 'The transaction is awaiting confirmation from the beneficiary bank or network. The amount is on hold and reduces your available balance. Most pending UPI payments resolve within 1 working day: either they complete, or the money is automatically returned.',
  failed: 'The transaction failed and no money was moved from your account.'
};

/** Deterministic explanation facts for one transaction; the assistant phrases them. */
export function explainTransaction(db, userId, idOrReference) {
  const row = findTransaction(db, userId, idOrReference);
  const accounts = accountsMap(db, userId);
  const txn = formatTransaction(db, row, accounts);
  const history = db.all(`SELECT amount_paise, date FROM transactions WHERE user_id = :userId AND merchant = :merchant AND direction = :direction
                          AND status = 'success' AND id <> :id AND date >= :since ORDER BY date DESC`,
  { userId, merchant: row.merchant, direction: row.direction, id: row.id, since: addDays(row.date, -180) });
  const avg = history.length ? Math.round(sumPaise(history.map((h) => h.amount_paise)) / history.length) : null;
  const duplicates = findDuplicateCharges(db, userId, { startDate: addDays(row.date, -1), endDate: addDays(row.date, 1) })
    .filter((group) => group.transactions.some((t) => t.id === row.id));
  const complaint = db.get('SELECT reference, status, category FROM complaints WHERE user_id = :userId AND transaction_id = :id', { userId, id: row.id });
  const ageDays = daysBetween(row.date, today());
  const suggestedActions = [];
  if (row.status === 'pending' && ageDays >= 2) suggestedActions.push('raise_complaint:pending_payment');
  if (row.status === 'failed') suggestedActions.push('retry_payment_if_needed');
  if (duplicates.length) suggestedActions.push('raise_complaint:duplicate_charge');
  return {
    transaction: txn,
    statusExplanation: STATUS_GUIDANCE[row.status],
    failureReason: row.failure_reason,
    ageDays,
    merchantHistory: {
      previousCount180d: history.length,
      averageAmount: avg != null ? money(avg) : null,
      lastDate: history[0]?.date ?? null,
      isFirstTimeMerchant: history.length === 0
    },
    possibleDuplicate: duplicates.length > 0,
    duplicateGroup: duplicates[0] ?? null,
    existingComplaint: complaint ?? null,
    suggestedActions
  };
}

/**
 * Duplicate-looking charges: same account, merchant and amount, debits that
 * were not failed, posted within 30 minutes of each other.
 */
export function findDuplicateCharges(db, userId, rangeArgs = { period: 'last_30_days' }) {
  const range = resolveRange(rangeArgs) ?? resolvePeriod('last_30_days');
  const rows = db.all(`SELECT * FROM transactions WHERE user_id = :userId AND direction = 'debit' AND status <> 'failed'
                       AND date BETWEEN :startDate AND :endDate ORDER BY account_id, merchant, amount_paise, posted_at`,
  { userId, startDate: range.startDate, endDate: range.endDate });
  const accounts = accountsMap(db, userId);
  const groups = [];
  let current = [];
  const flush = () => {
    if (current.length > 1) {
      groups.push({
        merchant: current[0].merchant,
        amount: money(current[0].amount_paise),
        count: current.length,
        potentialOvercharge: money(current[0].amount_paise * (current.length - 1)),
        transactions: current.map((r) => formatTransaction(db, r, accounts))
      });
    }
    current = [];
  };
  for (const row of rows) {
    const prev = current.at(-1);
    const sameKey = prev && prev.account_id === row.account_id && prev.merchant === row.merchant && prev.amount_paise === row.amount_paise;
    const withinWindow = prev && (Date.parse(row.posted_at) - Date.parse(prev.posted_at)) <= 30 * 60_000;
    if (sameKey && withinWindow) current.push(row);
    else {
      flush();
      current = [row];
    }
  }
  flush();
  return groups;
}

/**
 * Unusual spending: (a) single expense debits ≥ 3× the category's median over
 * the prior 90 days and ≥ ₹2,000; (b) first-time merchants with ≥ ₹5,000;
 * (c) categories whose period total is ≥ 1.5× their 3-month monthly average (+₹2,000).
 */
export function findUnusualSpending(db, userId, rangeArgs = { period: 'this_month' }) {
  const range = resolveRange(rangeArgs) ?? resolvePeriod('this_month');
  const expenseIds = expenseCategoryIds(db);
  const placeholders = expenseIds.map((_, i) => `:c${i}`).join(',');
  const catParams = Object.fromEntries(expenseIds.map((id, i) => [`c${i}`, id]));
  const baselineStart = addDays(range.startDate, -90);
  const baselineEnd = addDays(range.startDate, -1);
  const baseline = db.all(`SELECT category_id, merchant, amount_paise FROM transactions WHERE user_id = :userId AND direction = 'debit' AND status = 'success'
                           AND category_id IN (${placeholders}) AND date BETWEEN :s AND :e`, { userId, s: baselineStart, e: baselineEnd, ...catParams });
  const current = db.all(`SELECT * FROM transactions WHERE user_id = :userId AND direction = 'debit' AND status = 'success'
                          AND category_id IN (${placeholders}) AND date BETWEEN :s AND :e ORDER BY amount_paise DESC`, { userId, s: range.startDate, e: range.endDate, ...catParams });
  const byCat = new Map();
  const knownMerchants = new Set();
  for (const b of baseline) {
    if (!byCat.has(b.category_id)) byCat.set(b.category_id, []);
    byCat.get(b.category_id).push(b.amount_paise);
    knownMerchants.add(b.merchant);
  }
  const median = (values) => {
    const s = [...values].sort((x, y) => x - y);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
  };
  const accounts = accountsMap(db, userId);
  const largeTransactions = [];
  for (const row of current) {
    const hist = byCat.get(row.category_id) ?? [];
    const med = hist.length >= 3 ? median(hist) : null;
    const reasons = [];
    if (med && row.amount_paise >= med * 3 && row.amount_paise >= 200_000) reasons.push(`about ${Math.round(row.amount_paise / med)}× your typical ${formatCategory(db, row.category_id).label.toLowerCase()} transaction (${money(med).formatted})`);
    if (!knownMerchants.has(row.merchant) && row.amount_paise >= 500_000) reasons.push('first payment to this merchant in the last 90 days');
    if (reasons.length) largeTransactions.push({ transaction: formatTransaction(db, row, accounts), reasons, typicalAmount: med ? money(med) : null });
  }
  const periodDays = daysBetween(range.startDate, range.endDate) + 1;
  const categorySpikes = [];
  const currentTotals = new Map();
  for (const row of current) currentTotals.set(row.category_id, (currentTotals.get(row.category_id) ?? 0) + row.amount_paise);
  for (const [cat, total] of currentTotals) {
    const hist = byCat.get(cat) ?? [];
    const baselineForPeriod = Math.round((sumPaise(hist) / 90) * periodDays);
    if (total >= baselineForPeriod * 1.5 && total - baselineForPeriod >= 200_000) {
      categorySpikes.push({ category: formatCategory(db, cat), total: money(total), typicalForPeriod: money(baselineForPeriod), increase: money(total - baselineForPeriod) });
    }
  }
  categorySpikes.sort((a, b) => b.increase.paise - a.increase.paise);
  return { range, largeTransactions: largeTransactions.slice(0, 10), categorySpikes, method: 'Compared with your previous 90 days of successful spending.' };
}
