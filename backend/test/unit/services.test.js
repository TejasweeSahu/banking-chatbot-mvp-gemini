import test from 'node:test';
import assert from 'node:assert/strict';
import { balanceOf, freshDb, userCtx } from '../helpers.js';
import { listAccounts } from '../../src/services/accountService.js';
import { findDuplicateCharges, findUnusualSpending, searchTransactions } from '../../src/services/transactionService.js';
import { compareSpending, savingsCapacity, spendingSummary, topTransactions } from '../../src/services/analyticsService.js';
import { listBudgets, setBudget } from '../../src/services/budgetService.js';
import { listRecurringPayments } from '../../src/services/recurringService.js';
import { resolveBeneficiary } from '../../src/services/beneficiaryService.js';

const T = 'usr_tejas';

/** Independent SQL used to cross-check service arithmetic. */
function sqlSpend(db, start, end, category) {
  return db.get(`SELECT COALESCE(SUM(t.amount_paise), 0) AS s FROM transactions t JOIN categories c ON c.id = t.category_id
                 WHERE t.user_id = :u AND t.direction = 'debit' AND t.status = 'success' AND c.kind = 'expense'
                 AND t.date BETWEEN :start AND :end ${category ? 'AND t.category_id = :category' : ''}`,
  { u: T, start, end, ...(category ? { category } : {}) }).s;
}

test('balances: totals equal the sum of accounts; available = balance − pending holds', () => {
  const db = freshDb();
  const r = listAccounts(db, T);
  assert.equal(r.accounts.length, 3);
  assert.equal(r.totalBalance.paise, r.accounts.reduce((s, a) => s + a.balance.paise, 0));
  const sav = r.accounts.find((a) => a.id === 'acc_tejas_sav');
  assert.equal(sav.holds.paise, 235000, 'pending Urban Company UPI is held');
  assert.equal(sav.availableBalance.paise, sav.balance.paise - 235000);
  assert.equal(r.accounts.find((a) => a.type === 'fixed_deposit').availableBalance.paise, 0);
  assert.ok(r.accounts.every((a) => /^••\d{4}$/.test(a.maskedNumber)), 'only masked numbers are returned');
  assert.ok(!JSON.stringify(r).includes('30881209372048'), 'full account number never leaves the service');
});

test('ledger invariant: balance = opening + successful credits − successful debits', () => {
  const db = freshDb();
  for (const a of db.all('SELECT * FROM accounts')) {
    const { net } = db.get(`SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_paise ELSE -amount_paise END), 0) AS net
                            FROM transactions WHERE account_id = :id AND status = 'success'`, { id: a.id });
    assert.equal(a.balance_paise, a.opening_balance_paise + net, a.id);
  }
});

test('transaction search filters by merchant, category, status, type, amount and date', () => {
  const db = freshDb();
  const swiggy = searchTransactions(db, T, { merchant: 'swiggy', limit: 100 });
  assert.ok(swiggy.total > 0 && swiggy.items.every((t) => t.merchant === 'Swiggy'));
  const food = searchTransactions(db, T, { category: 'food', period: 'this_month', limit: 100 });
  assert.ok(food.items.every((t) => t.category.id === 'food' && t.date >= '2026-11-01'));
  assert.equal(searchTransactions(db, T, { status: 'pending' }).total, 1);
  const failed = searchTransactions(db, T, { status: 'failed' });
  assert.equal(failed.total, 1);
  assert.match(failed.items[0].failureReason, /timeout/i);
  assert.ok(searchTransactions(db, T, { direction: 'credit', limit: 100 }).items.every((t) => t.direction === 'credit'));
  const range = searchTransactions(db, T, { minAmountPaise: 100000, maxAmountPaise: 200000, limit: 100 });
  assert.ok(range.items.every((t) => t.amount.paise >= 100000 && t.amount.paise <= 200000));
  const dated = searchTransactions(db, T, { startDate: '2026-10-01', endDate: '2026-10-31', limit: 100 });
  assert.ok(dated.items.every((t) => t.date.startsWith('2026-10')));
  const sorted = searchTransactions(db, T, { sort: 'amount_desc', limit: 10 }).items.map((t) => t.amount.paise);
  assert.deepEqual(sorted, [...sorted].sort((a, b) => b - a));
  assert.equal(searchTransactions(db, T, { query: '%' }).total, 0, 'LIKE wildcards are escaped');
});

test('users can never see each other\'s transactions', () => {
  const db = freshDb();
  const aisha = searchTransactions(db, 'usr_aisha', { limit: 100 });
  assert.ok(aisha.items.length > 0 && aisha.items.every((t) => t.account.id === 'acc_aisha_sav'));
  assert.equal(searchTransactions(db, 'usr_aisha', { merchant: 'Croma' }).total, 0);
});

test('spending summary matches an independent SQL calculation and excludes non-spending', () => {
  const db = freshDb();
  const s = spendingSummary(db, T, { period: 'this_month' });
  assert.equal(s.total.paise, sqlSpend(db, '2026-11-01', '2026-11-14'));
  assert.equal(s.byCategory.reduce((sum, c) => sum + c.total.paise, 0), s.total.paise);
  assert.ok(!s.byCategory.some((c) => ['transfers', 'investments', 'income'].includes(c.category.id)));
  const food = spendingSummary(db, T, { period: 'this_month', category: 'food' });
  assert.equal(food.total.paise, sqlSpend(db, '2026-11-01', '2026-11-14', 'food'));
  assert.equal(s.pendingDebits.paise, 235000, 'pending debits are reported separately');
});

test('month-over-month comparison is arithmetically consistent', () => {
  const db = freshDb();
  const c = compareSpending(db, T, {});
  assert.equal(c.current.total.paise, sqlSpend(db, '2026-11-01', '2026-11-14'));
  assert.equal(c.previous.total.paise, sqlSpend(db, '2026-10-01', '2026-10-31'));
  assert.equal(c.change.paise, c.current.total.paise - c.previous.total.paise);
  assert.equal(c.likeForLike.total.paise, sqlSpend(db, '2026-10-01', '2026-10-14'));
  assert.equal(c.byCategory.reduce((s, x) => s + x.change.paise, 0), c.change.paise);
  assert.ok(c.change.paise > 0, 'seed scenario: spending increased this month');
  assert.equal(c.drivers[0].category.id, 'shopping', 'the Croma purchase drives the increase');
  assert.equal(c.drivers[0].largestTransactions[0].merchant, 'Croma');
});

test('top transactions are the largest debits, in order', () => {
  const db = freshDb();
  const top = topTransactions(db, T, { limit: 5 });
  assert.equal(top.items.length, 5);
  const amounts = top.items.map((t) => t.amount.paise);
  assert.deepEqual(amounts, [...amounts].sort((a, b) => b - a));
  const maxSql = db.get(`SELECT MAX(amount_paise) AS m FROM transactions WHERE user_id = :u AND direction = 'debit' AND status = 'success' AND date >= '2026-11-01'`, { u: T }).m;
  assert.equal(amounts[0], maxSql);
});

test('duplicate detection finds the double Swiggy charge but not the failed-then-retried UPI', () => {
  const db = freshDb();
  const groups = findDuplicateCharges(db, T, { period: 'last_30_days' });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].merchant, 'Swiggy');
  assert.equal(groups[0].amount.paise, 48600);
  assert.equal(groups[0].count, 2);
});

test('unusual spending flags the large first-time Croma purchase and the shopping spike', () => {
  const db = freshDb();
  const u = findUnusualSpending(db, T, { period: 'this_month' });
  assert.ok(u.largeTransactions.some((l) => l.transaction.merchant === 'Croma'));
  assert.ok(u.categorySpikes.some((c) => c.category.id === 'shopping'));
});

test('savings capacity equals the documented formula over its own breakdown', () => {
  const db = freshDb();
  const s = savingsCapacity(db, T);
  const b = s.breakdown;
  const raw = b.incomeReceived.paise - b.spentSoFar.paise - b.committedUpcoming.paise - b.projectedDiscretionary.paise - b.safetyBuffer.paise;
  assert.equal(s.safeToSave.paise, Math.max(0, Math.floor(raw / 10000) * 10000));
  assert.equal(b.safetyBuffer.paise, Math.round(b.incomeReceived.paise / 10));
  assert.equal(b.spentSoFar.paise, sqlSpend(db, '2026-11-01', '2026-11-14'));
  assert.ok(s.safeToSave.paise > 0);
  assert.ok(s.alreadyScheduledSavings.length === 0 || s.alreadyScheduledSavings.every((x) => x.amount.paise > 0));
});

test('budget progress is derived from the ledger; setBudget validates', () => {
  const db = freshDb();
  const food = listBudgets(db, T).budgets.find((b) => b.category.id === 'food');
  assert.equal(food.spent.paise, sqlSpend(db, '2026-11-01', '2026-11-14', 'food'));
  const shopping = listBudgets(db, T).budgets.find((b) => b.category.id === 'shopping');
  assert.equal(shopping.status, 'exceeded');
  assert.equal(shopping.overBy.paise, shopping.spent.paise - shopping.limit.paise);
  const updated = setBudget(db, T, { category: 'food', amountPaise: 900000 });
  assert.equal(updated.limit.paise, 900000);
  assert.throws(() => setBudget(db, T, { category: 'income', amountPaise: 900000 }), /spending categories/);
  assert.throws(() => setBudget(db, T, { category: 'food', amountPaise: 5 }), /between/);
});

test('recurring payments list subscriptions and flag ones started this month', () => {
  const db = freshDb();
  const r = listRecurringPayments(db, T);
  assert.deepEqual(r.subscriptions.map((s) => s.name).sort(), ['Cult.fit membership', 'Disney+ Hotstar', 'Netflix', 'Spotify Premium']);
  assert.equal(r.subscriptionMonthlyTotal.paise, 150000 + 29900 + 64900 + 11900);
  assert.deepEqual(r.newThisMonth, ['Disney+ Hotstar']);
});

test('beneficiary resolution: ambiguity, exact names, bank hints, nicknames, unknown names, isolation', () => {
  const db = freshDb();
  const r = resolveBeneficiary(db, T, 'Rahul');
  assert.equal(r.status, 'ambiguous');
  assert.deepEqual(r.candidates.map((b) => b.id).sort(), ['ben_rahul_s', 'ben_rahul_v']);
  assert.equal(resolveBeneficiary(db, T, 'Rahul Sharma').beneficiary.id, 'ben_rahul_s');
  assert.equal(resolveBeneficiary(db, T, 'rahul hdfc').beneficiary.id, 'ben_rahul_s');
  assert.equal(resolveBeneficiary(db, T, 'Rahul Verma — ICICI Bank ••7310').beneficiary.id, 'ben_rahul_v');
  assert.equal(resolveBeneficiary(db, T, 'mom').beneficiary.id, 'ben_mom');
  assert.equal(resolveBeneficiary(db, T, 'Priya').beneficiary.id, 'ben_priya');
  assert.equal(resolveBeneficiary(db, T, 'Rahul Mehta').status, 'not_found', "another customer's payee is not visible");
  assert.equal(resolveBeneficiary(db, T, 'ben_aisha_rahul').status, 'not_found');
});

test('seed is deterministic for a given anchor date', () => {
  const a = freshDb();
  const b = freshDb();
  const snapshot = (db) => db.all('SELECT id, date, merchant, amount_paise, status FROM transactions ORDER BY id');
  assert.deepEqual(snapshot(a), snapshot(b));
  assert.equal(balanceOf(a, 'acc_tejas_sav'), balanceOf(b, 'acc_tejas_sav'));
});
