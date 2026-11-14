/**
 * Deterministic spending analytics. Every figure is computed here from stored
 * ledger rows; the LLM only explains results and never does the arithmetic.
 *
 * Definitions:
 *  - Spending  = successful debits in expense categories (excludes transfers to
 *                people/own accounts, investments, failed and pending items).
 *  - Income    = successful credits in income categories (salary, interest, refunds).
 */

import { money, percentChange, percentOf, sumPaise } from '../lib/money.js';
import { addDays, addMonths, daysBetween, monthEnd, monthLabel, monthStart, resolvePeriod, today } from '../lib/dates.js';
import { accountsMap } from './accountService.js';
import { expenseCategoryIds, formatCategory, formatTransaction, getCategories } from './common.js';
import { resolveRange } from './transactionService.js';
import { listUpcomingPayments } from './recurringService.js';

export const SPENDING_DEFINITION = 'Spending counts successful debits in expense categories. Transfers, investments (SIPs), pending and failed payments are excluded.';

function expenseFilter(db) {
  const ids = expenseCategoryIds(db);
  return { sql: `category_id IN (${ids.map((_, i) => `:ec${i}`).join(',')})`, params: Object.fromEntries(ids.map((id, i) => [`ec${i}`, id])) };
}

function spendingRows(db, userId, range, { category, accountId } = {}) {
  const ef = expenseFilter(db);
  const where = [`user_id = :userId`, `direction = 'debit'`, `status = 'success'`, ef.sql, 'date BETWEEN :s AND :e'];
  const params = { userId, s: range.startDate, e: range.endDate, ...ef.params };
  if (category) { where.push('category_id = :category'); params.category = category; }
  if (accountId) { where.push('account_id = :accountId'); params.accountId = accountId; }
  return db.all(`SELECT * FROM transactions WHERE ${where.join(' AND ')} ORDER BY amount_paise DESC`, params);
}

function totalsByCategory(db, rows) {
  const map = new Map();
  for (const r of rows) {
    const entry = map.get(r.category_id) ?? { total: 0, count: 0 };
    entry.total += r.amount_paise;
    entry.count += 1;
    map.set(r.category_id, entry);
  }
  return map;
}

export function spendingSummary(db, userId, args = {}) {
  const range = resolveRange(args) ?? resolvePeriod('this_month');
  const rows = spendingRows(db, userId, range, args);
  const total = sumPaise(rows.map((r) => r.amount_paise));
  const byCat = totalsByCategory(db, rows);
  const days = daysBetween(range.startDate, range.endDate) + 1;
  const merchants = new Map();
  for (const r of rows) merchants.set(r.merchant, (merchants.get(r.merchant) ?? 0) + r.amount_paise);
  const pending = db.get(`SELECT COALESCE(SUM(amount_paise), 0) AS p FROM transactions WHERE user_id = :userId AND direction = 'debit' AND status = 'pending' AND date BETWEEN :s AND :e`,
    { userId, s: range.startDate, e: range.endDate }).p;
  return {
    range,
    category: args.category ? formatCategory(db, args.category) : null,
    total: money(total),
    transactionCount: rows.length,
    dailyAverage: money(Math.round(total / Math.max(days, 1))),
    byCategory: [...byCat.entries()]
      .map(([id, v]) => ({ category: formatCategory(db, id), total: money(v.total), count: v.count, sharePct: percentOf(v.total, total) }))
      .sort((a, b) => b.total.paise - a.total.paise),
    topMerchants: [...merchants.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([merchant, p]) => ({ merchant, total: money(p) })),
    pendingDebits: money(pending),
    definition: SPENDING_DEFINITION
  };
}

/**
 * Compare two periods. Defaults to this month (to date) vs last month, and also
 * reports the like-for-like window (same days of last month) so a partial month
 * is not unfairly compared with a full one.
 */
export function compareSpending(db, userId, { currentPeriod = 'this_month', previousPeriod = 'last_month', category } = {}) {
  const current = resolvePeriod(currentPeriod);
  const previous = resolvePeriod(previousPeriod);
  const curRows = spendingRows(db, userId, current, { category });
  const prevRows = spendingRows(db, userId, previous, { category });
  const curTotal = sumPaise(curRows.map((r) => r.amount_paise));
  const prevTotal = sumPaise(prevRows.map((r) => r.amount_paise));

  let likeForLike = null;
  if (currentPeriod === 'this_month' && previousPeriod === 'last_month') {
    const elapsed = daysBetween(current.startDate, current.endDate);
    const lflRange = { startDate: previous.startDate, endDate: addDays(previous.startDate, Math.min(elapsed, daysBetween(previous.startDate, previous.endDate))) };
    const lflTotal = sumPaise(spendingRows(db, userId, lflRange, { category }).map((r) => r.amount_paise));
    likeForLike = { range: { ...lflRange, label: `${monthLabel(previous.startDate)}, same days` }, total: money(lflTotal), change: money(curTotal - lflTotal), changePct: percentChange(lflTotal, curTotal) };
  }

  const curCat = totalsByCategory(db, curRows);
  const prevCat = totalsByCategory(db, prevRows);
  const cats = new Set([...curCat.keys(), ...prevCat.keys()]);
  const accounts = accountsMap(db, userId);
  const byCategory = [...cats].map((id) => {
    const c = curCat.get(id)?.total ?? 0;
    const p = prevCat.get(id)?.total ?? 0;
    return { category: formatCategory(db, id), current: money(c), previous: money(p), change: money(c - p), changePct: percentChange(p, c) };
  }).sort((a, b) => b.change.paise - a.change.paise);

  // Drivers: the categories that rose most, with their largest current-period transactions.
  const drivers = byCategory.filter((c) => c.change.paise > 0).slice(0, 3).map((c) => ({
    ...c,
    largestTransactions: curRows.filter((r) => r.category_id === c.category.id).slice(0, 3).map((r) => formatTransaction(db, r, accounts))
  }));

  return {
    current: { range: current, total: money(curTotal), transactionCount: curRows.length },
    previous: { range: previous, total: money(prevTotal), transactionCount: prevRows.length },
    change: money(curTotal - prevTotal),
    changePct: percentChange(prevTotal, curTotal),
    likeForLike,
    byCategory,
    drivers,
    category: category ? formatCategory(db, category) : null,
    definition: SPENDING_DEFINITION
  };
}

export function topTransactions(db, userId, { limit = 5, direction = 'debit', period = 'this_month', startDate, endDate, category } = {}) {
  const range = resolveRange({ period, startDate, endDate });
  const params = { userId, s: range.startDate, e: range.endDate, direction, limit };
  let catSql = '';
  if (category) { catSql = 'AND category_id = :category'; params.category = category; }
  const rows = db.all(`SELECT * FROM transactions WHERE user_id = :userId AND direction = :direction AND status = 'success'
                       AND date BETWEEN :s AND :e ${catSql} ORDER BY amount_paise DESC, posted_at DESC LIMIT :limit`, params);
  const accounts = accountsMap(db, userId);
  return { range, direction, items: rows.map((r) => formatTransaction(db, r, accounts)), total: money(sumPaise(rows.map((r) => r.amount_paise))) };
}

/** Monthly income / spending / investments / transfers for the last N months (current month is to-date). */
export function monthlyTrend(db, userId, { months = 6 } = {}) {
  const cats = getCategories(db);
  const start = addMonths(monthStart(today()), -(months - 1));
  const rows = db.all(`SELECT substr(date, 1, 7) AS ym, category_id, direction, SUM(amount_paise) AS total FROM transactions
                       WHERE user_id = :userId AND status = 'success' AND date BETWEEN :s AND :e
                       AND NOT (category_id = 'transfers' AND channel = 'internal')
                       GROUP BY ym, category_id, direction`, { userId, s: start, e: today() });
  const result = [];
  for (let i = 0; i < months; i += 1) {
    const ms = addMonths(start, i);
    const ym = ms.slice(0, 7);
    const bucket = { income: 0, spending: 0, investments: 0, transfers: 0 };
    for (const r of rows.filter((x) => x.ym === ym)) {
      const kind = cats.get(r.category_id)?.kind;
      if (r.direction === 'credit' && kind === 'income') bucket.income += r.total;
      else if (r.direction === 'debit' && kind === 'expense') bucket.spending += r.total;
      else if (r.direction === 'debit' && kind === 'investment') bucket.investments += r.total;
      else if (r.direction === 'debit' && kind === 'transfer') bucket.transfers += r.total;
    }
    result.push({
      month: ym,
      label: monthLabel(ms),
      isCurrent: ym === today().slice(0, 7),
      income: money(bucket.income),
      spending: money(bucket.spending),
      investments: money(bucket.investments),
      transfers: money(bucket.transfers),
      net: money(bucket.income - bucket.spending - bucket.investments - bucket.transfers)
    });
  }
  return { months: result };
}

export function monthCashflow(db, userId) {
  const range = resolvePeriod('this_month');
  const cats = getCategories(db);
  const rows = db.all(`SELECT category_id, direction, SUM(amount_paise) AS total FROM transactions WHERE user_id = :userId AND status = 'success'
                       AND date BETWEEN :s AND :e AND NOT (category_id = 'transfers' AND channel = 'internal') GROUP BY category_id, direction`,
  { userId, s: range.startDate, e: range.endDate });
  let income = 0;
  let spending = 0;
  for (const r of rows) {
    const kind = cats.get(r.category_id)?.kind;
    if (r.direction === 'credit' && kind === 'income') income += r.total;
    if (r.direction === 'debit' && kind === 'expense') spending += r.total;
  }
  return { range, income: money(income), spending: money(spending), net: money(income - spending), savingsRatePct: income > 0 ? percentOf(income - spending, income) : null };
}

/**
 * How much can be safely saved this month:
 *   safe = income received − spent so far − committed upcoming payments (to month end)
 *          − projected discretionary spend for the remaining days − 10% income buffer.
 * Projected discretionary spend = average daily non-recurring spending over the
 * previous 3 full months × remaining days in the month.
 */
export function savingsCapacity(db, userId) {
  const ref = today();
  const range = resolvePeriod('this_month');
  const flow = monthCashflow(db, userId);
  const end = monthEnd(ref);
  const remainingDays = daysBetween(ref, end);

  const upcoming = listUpcomingPayments(db, userId, { untilDate: end }).items;
  const committedExpenses = upcoming.filter((u) => u.categoryKind === 'expense');
  const committedSavings = upcoming.filter((u) => u.categoryKind !== 'expense');
  const committedPaise = sumPaise(committedExpenses.map((u) => u.amount.paise));

  const recurringMerchants = new Set(db.all('SELECT merchant FROM recurring_payments WHERE user_id = :userId', { userId }).map((r) => r.merchant));
  const baseStart = addMonths(monthStart(ref), -3);
  const baseEnd = addDays(monthStart(ref), -1);
  const baseRows = spendingRows(db, userId, { startDate: baseStart, endDate: baseEnd }).filter((r) => !recurringMerchants.has(r.merchant) && !['bills', 'rent'].includes(r.category_id));
  const baseDays = daysBetween(baseStart, baseEnd) + 1;
  const dailyDiscretionary = Math.round(sumPaise(baseRows.map((r) => r.amount_paise)) / baseDays);
  const projectedDiscretionary = dailyDiscretionary * remainingDays;
  const buffer = Math.round(flow.income.paise / 10);

  const raw = flow.income.paise - flow.spending.paise - committedPaise - projectedDiscretionary - buffer;
  const safe = Math.max(0, Math.floor(raw / 10_000) * 10_000); // round down to the nearest ₹100

  return {
    range,
    safeToSave: money(safe),
    shortfall: raw < 0 ? money(-raw) : null,
    breakdown: {
      incomeReceived: flow.income,
      spentSoFar: flow.spending,
      committedUpcoming: money(committedPaise),
      projectedDiscretionary: money(projectedDiscretionary),
      safetyBuffer: money(buffer)
    },
    remainingDays,
    dailyDiscretionaryAverage: money(dailyDiscretionary),
    committedItems: committedExpenses.map((u) => ({ name: u.name, dueDate: u.dueDate, amount: u.amount })),
    alreadyScheduledSavings: committedSavings.map((u) => ({ name: u.name, dueDate: u.dueDate, amount: u.amount })),
    assumptions: [
      'Projected spending uses your average daily non-recurring spending over the previous 3 full months.',
      'A safety buffer of 10% of this month\'s income is kept aside.',
      'Scheduled SIPs and transfers to your own accounts are already savings and are not deducted.',
      'Figures are rounded down to the nearest ₹100.'
    ]
  };
}
