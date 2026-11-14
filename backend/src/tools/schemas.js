/**
 * Reusable Zod building blocks for tool arguments. Every tool schema is strict
 * (unknown keys rejected) and bounded.
 */

import { z } from 'zod';
import { toPaise } from '../lib/money.js';
import { isValidIsoDate, PERIODS } from '../lib/dates.js';

export const EXPENSE_CATEGORIES = ['food', 'groceries', 'transport', 'shopping', 'bills', 'subscriptions', 'entertainment', 'health', 'travel', 'rent'];
export const ALL_CATEGORIES = [...EXPENSE_CATEGORIES, 'investments', 'transfers', 'income', 'refunds'];

export const isoDate = z.string().refine(isValidIsoDate, 'must be a valid date in YYYY-MM-DD format');
export const period = z.enum(PERIODS);
export const shortText = (max, description) => z.string().trim().min(1).max(max).describe(description);

/** Amount as a decimal string or number → integer paise. Rejects >2 decimals, negatives, NaN. */
export const amount = (description, { maxRupees = 10_000_000 } = {}) => z
  .union([z.string().max(20), z.number()])
  .describe(description)
  .transform((value, ctx) => {
    const paise = toPaise(value);
    if (paise == null || paise <= 0) {
      ctx.addIssue({ code: 'custom', message: 'must be a positive INR amount with at most 2 decimal places' });
      return z.NEVER;
    }
    if (paise > maxRupees * 100) {
      ctx.addIssue({ code: 'custom', message: `must not exceed ₹${maxRupees.toLocaleString('en-IN')}` });
      return z.NEVER;
    }
    return paise;
  });

export const dateRangeShape = {
  period: period.optional().describe('Named period. this_month is month-to-date; last_month is the full previous calendar month.'),
  startDate: isoDate.optional().describe('Inclusive start date (YYYY-MM-DD). Use instead of period for custom ranges.'),
  endDate: isoDate.optional().describe('Inclusive end date (YYYY-MM-DD).')
};

export function checkRange(value, ctx) {
  if (value.period && (value.startDate || value.endDate)) ctx.addIssue({ code: 'custom', message: 'use either period or startDate/endDate, not both', path: ['period'] });
  if (value.startDate && value.endDate && value.startDate > value.endDate) ctx.addIssue({ code: 'custom', message: 'startDate must be on or before endDate', path: ['startDate'] });
}

export const empty = z.strictObject({});
