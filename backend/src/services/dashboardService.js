/**
 * Dashboard aggregate: one call that composes the other services.
 */

import { listAccounts } from './accountService.js';
import { monthCashflow, monthlyTrend, spendingSummary } from './analyticsService.js';
import { listBudgets } from './budgetService.js';
import { listUpcomingPayments } from './recurringService.js';
import { findDuplicateCharges, findUnusualSpending, searchTransactions } from './transactionService.js';
import { listCards } from './cardService.js';
import { listComplaints } from './supportService.js';
import { today } from '../lib/dates.js';

export function getDashboard(db, user) {
  const accounts = listAccounts(db, user.id);
  const recent = searchTransactions(db, user.id, { limit: 6 });
  const pendingCount = searchTransactions(db, user.id, { status: 'pending', limit: 1 }).total;
  const failedCount = searchTransactions(db, user.id, { status: 'failed', period: 'last_30_days', limit: 1 }).total;
  const unusual = findUnusualSpending(db, user.id, { period: 'this_month' });
  return {
    asOf: today(),
    user: { firstName: user.firstName, fullName: user.fullName, role: user.role },
    ...accounts,
    month: monthCashflow(db, user.id),
    spending: spendingSummary(db, user.id, { period: 'this_month' }),
    trend: monthlyTrend(db, user.id, { months: 6 }).months,
    budgets: listBudgets(db, user.id),
    upcoming: listUpcomingPayments(db, user.id),
    recentTransactions: recent.items,
    cards: listCards(db, user.id),
    insights: {
      duplicates: findDuplicateCharges(db, user.id, { period: 'last_30_days' }),
      unusual: unusual.largeTransactions.slice(0, 3),
      categorySpikes: unusual.categorySpikes.slice(0, 3),
      pendingCount,
      failedCount,
      openComplaints: listComplaints(db, user.id).filter((c) => !['resolved', 'closed'].includes(c.status)).length
    }
  };
}
