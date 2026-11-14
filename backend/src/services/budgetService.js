/**
 * Monthly category budgets with progress derived from the ledger.
 */

import { money, percentOf, sumPaise } from '../lib/money.js';
import { daysBetween, monthEnd, resolvePeriod, today } from '../lib/dates.js';
import { badRequest } from '../lib/errors.js';
import { expenseCategoryIds, formatCategory, newId } from './common.js';
import { audit } from './auditService.js';

const MAX_BUDGET_PAISE = 100_000_000; // ₹10,00,000

export function listBudgets(db, userId) {
  const range = resolvePeriod('this_month');
  const elapsedDays = daysBetween(range.startDate, range.endDate) + 1;
  const totalDays = daysBetween(range.startDate, monthEnd(today())) + 1;
  const rows = db.all('SELECT * FROM budgets WHERE user_id = :userId', { userId });
  const budgets = rows.map((b) => {
    const spent = db.get(`SELECT COALESCE(SUM(amount_paise), 0) AS s FROM transactions WHERE user_id = :userId AND category_id = :cat
                          AND direction = 'debit' AND status = 'success' AND date BETWEEN :start AND :end`,
    { userId, cat: b.category_id, start: range.startDate, end: range.endDate }).s;
    const pct = percentOf(spent, b.monthly_limit_paise);
    const projected = Math.round((spent * totalDays) / elapsedDays);
    return {
      id: b.id,
      category: formatCategory(db, b.category_id),
      limit: money(b.monthly_limit_paise),
      spent: money(spent),
      remaining: money(Math.max(0, b.monthly_limit_paise - spent)),
      overBy: spent > b.monthly_limit_paise ? money(spent - b.monthly_limit_paise) : null,
      percentUsed: pct,
      projectedMonthEnd: money(projected),
      status: spent > b.monthly_limit_paise ? 'exceeded' : pct >= 80 ? 'near_limit' : projected > b.monthly_limit_paise ? 'at_risk' : 'on_track'
    };
  }).sort((a, b) => b.percentUsed - a.percentUsed);
  return {
    range,
    budgets,
    totalLimit: money(sumPaise(budgets.map((b) => b.limit.paise))),
    totalSpent: money(sumPaise(budgets.map((b) => b.spent.paise)))
  };
}

export function setBudget(db, userId, { category, amountPaise }) {
  if (!expenseCategoryIds(db).includes(category)) throw badRequest('Budgets can only be set for spending categories.');
  if (!Number.isSafeInteger(amountPaise) || amountPaise < 10_000 || amountPaise > MAX_BUDGET_PAISE) throw badRequest('Budget must be between ₹100 and ₹10,00,000.');
  const existing = db.get('SELECT id, monthly_limit_paise FROM budgets WHERE user_id = :userId AND category_id = :category', { userId, category });
  db.transaction(() => {
    if (existing) db.run('UPDATE budgets SET monthly_limit_paise = :amountPaise, updated_at = :now WHERE id = :id', { amountPaise, now: new Date().toISOString(), id: existing.id });
    else db.run('INSERT INTO budgets (id, user_id, category_id, monthly_limit_paise, updated_at) VALUES (:id, :userId, :category, :amountPaise, :now)', { id: newId('bud'), userId, category, amountPaise, now: new Date().toISOString() });
    audit(db, { userId, event: 'budget.set', resourceType: 'budget', resourceId: category, details: { previousPaise: existing?.monthly_limit_paise ?? null, newPaise: amountPaise } });
  });
  return listBudgets(db, userId).budgets.find((b) => b.category.id === category);
}
