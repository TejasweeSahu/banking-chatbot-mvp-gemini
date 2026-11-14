/**
 * Recurring payments: scheduled mandates (subscriptions, standing instructions,
 * SIPs, autopay) plus subscriptions detected from transaction patterns, and an
 * upcoming-payments calendar that merges mandates with due bills.
 */

import { money, sumPaise } from '../lib/money.js';
import { addDays, addMonths, monthStart, today } from '../lib/dates.js';
import { formatCategory, getCategories, maskNumber } from './common.js';

const KIND_LABELS = { subscription: 'Subscription', standing_instruction: 'Standing instruction', sip: 'SIP', autopay_bill: 'Bill autopay', emi: 'EMI' };

export function listRecurringPayments(db, userId) {
  const rows = db.all(`SELECT r.*, a.account_number, a.nickname AS account_nickname FROM recurring_payments r JOIN accounts a ON a.id = r.account_id
                       WHERE r.user_id = :userId ORDER BY r.next_due_date`, { userId });
  const scheduled = rows.map((r) => ({
    id: r.id,
    name: r.name,
    merchant: r.merchant,
    kind: r.kind,
    kindLabel: KIND_LABELS[r.kind],
    category: formatCategory(db, r.category_id),
    amount: money(r.amount_paise),
    frequency: r.frequency,
    nextDueDate: r.next_due_date,
    status: r.status,
    account: { id: r.account_id, nickname: r.account_nickname, maskedNumber: maskNumber(r.account_number) },
    lastCharged: db.get(`SELECT date FROM transactions WHERE user_id = :userId AND merchant = :merchant AND status = 'success' ORDER BY date DESC LIMIT 1`, { userId, merchant: r.merchant })?.date ?? null
  }));
  const subscriptions = scheduled.filter((s) => s.kind === 'subscription' && s.status === 'active');
  const monthlyCommitted = sumPaise(scheduled.filter((s) => s.status === 'active' && s.frequency === 'monthly').map((s) => s.amount.paise));
  const known = new Set(rows.map((r) => r.merchant));
  return {
    scheduled,
    subscriptions,
    subscriptionMonthlyTotal: money(sumPaise(subscriptions.map((s) => s.amount.paise))),
    monthlyCommitted: money(monthlyCommitted),
    detected: detectRecurringCharges(db, userId).filter((d) => !known.has(d.merchant)),
    newThisMonth: subscriptions.filter((s) => {
      const first = db.get(`SELECT MIN(date) AS d FROM transactions WHERE user_id = :userId AND merchant = :merchant AND status = 'success'`, { userId, merchant: s.merchant }).d;
      return first && first >= monthStart(today());
    }).map((s) => s.name)
  };
}

/** Merchants charged in ≥ 3 of the last 4 months with amounts within ±10% of each other. */
export function detectRecurringCharges(db, userId) {
  const since = addMonths(monthStart(today()), -4);
  const rows = db.all(`SELECT merchant, category_id, substr(date, 1, 7) AS ym, COUNT(*) AS n, SUM(amount_paise) AS total, MAX(amount_paise) AS maxp, MIN(amount_paise) AS minp
                       FROM transactions WHERE user_id = :userId AND direction = 'debit' AND status = 'success' AND date >= :since
                       GROUP BY merchant, ym`, { userId, since });
  const byMerchant = new Map();
  for (const r of rows) {
    if (!byMerchant.has(r.merchant)) byMerchant.set(r.merchant, []);
    byMerchant.get(r.merchant).push(r);
  }
  const cats = getCategories(db);
  const out = [];
  for (const [merchant, months] of byMerchant) {
    const singleCharge = months.filter((m) => m.n === 1);
    if (singleCharge.length < 3 || cats.get(months[0].category_id)?.kind === 'income') continue;
    const amounts = singleCharge.map((m) => m.total);
    const min = Math.min(...amounts);
    const max = Math.max(...amounts);
    if (max > min * 1.1) continue;
    out.push({ merchant, category: formatCategory(db, months[0].category_id), typicalAmount: money(Math.round(sumPaise(amounts) / amounts.length)), monthsSeen: singleCharge.length });
  }
  return out;
}

/** Recurring mandates and due bills between today and untilDate (default 30 days). */
export function listUpcomingPayments(db, userId, { untilDate = addDays(today(), 30) } = {}) {
  const cats = getCategories(db);
  const ref = today();
  const items = [];
  for (const r of db.all(`SELECT * FROM recurring_payments WHERE user_id = :userId AND status = 'active'`, { userId })) {
    let due = r.next_due_date;
    while (due <= untilDate) {
      if (due > ref) {
        items.push({ id: r.id, source: 'recurring', name: r.name, kindLabel: KIND_LABELS[r.kind], category: formatCategory(db, r.category_id), categoryKind: cats.get(r.category_id)?.kind, amount: money(r.amount_paise), dueDate: due });
      }
      due = addMonths(due, r.frequency === 'monthly' ? 1 : r.frequency === 'quarterly' ? 3 : 12);
    }
  }
  for (const b of db.all(`SELECT b.*, bl.name AS biller_name, bl.category_id FROM bills b JOIN billers bl ON bl.id = b.biller_id
                          WHERE b.user_id = :userId AND b.status = 'due' AND b.due_date <= :until`, { userId, until: untilDate })) {
    items.push({ id: b.id, source: 'bill', name: b.biller_name, kindLabel: 'Bill due', category: formatCategory(db, b.category_id), categoryKind: 'expense', amount: money(b.amount_paise), dueDate: b.due_date, overdue: b.due_date < ref });
  }
  items.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  return { untilDate, items, total: money(sumPaise(items.map((i) => i.amount.paise))) };
}
