/**
 * Tool registry: the complete, closed set of operations the model may request.
 *
 * Each tool declares: name, description, permission scope, strict Zod schema,
 * a UI label, and a handler that calls the service layer. The model never sees
 * the database or user IDs; identity comes from the authenticated session.
 *
 * Handlers return an envelope:
 *   { status, data?, message?, blocks: [...UI cards...], context?: "compact note for history" }
 * status ∈ success | needs_input | needs_clarification | rejected | awaiting_confirmation
 */

import { z } from 'zod';
import * as accounts from '../services/accountService.js';
import * as txns from '../services/transactionService.js';
import * as analytics from '../services/analyticsService.js';
import * as recurring from '../services/recurringService.js';
import * as budgets from '../services/budgetService.js';
import * as beneficiaries from '../services/beneficiaryService.js';
import * as transfers from '../services/transferService.js';
import * as bills from '../services/billService.js';
import * as cards from '../services/cardService.js';
import * as support from '../services/supportService.js';
import { createPendingAction } from '../services/actionService.js';
import { addDays, today } from '../lib/dates.js';
import { money } from '../lib/money.js';
import { ALL_CATEGORIES, EXPENSE_CATEGORIES, amount, checkRange, dateRangeShape, empty, period, shortText } from './schemas.js';

const ok = (data, blocks = [], context) => ({ status: 'success', data, blocks, context });

const txnContext = (items, label = 'Transactions shown') => items.length
  ? `[${label}: ${items.slice(0, 12).map((t) => `${t.id} ${t.merchant} ${t.amount.formatted} ${t.direction} ${t.date} ${t.status}`).join('; ')}]`
  : undefined;

/** Turns a prepare-service result into an envelope; "ready" results become pending actions. */
function preparedEnvelope(ctx, type, result, messageFor = (o) => o.label) {
  if (result.status === 'ready') {
    const action = createPendingAction(ctx.db, ctx.user, { type, payload: result.payload, preview: result.preview, conversationId: ctx.conversationId });
    return {
      status: 'awaiting_confirmation',
      data: { actionId: action.id, type, preview: result.preview, reusedExistingRequest: action.reused, note: 'Nothing has been executed. The user must press Confirm on the card shown in the app.' },
      blocks: [{ type: 'confirmation', action }],
      context: `[Prepared ${type} request ${action.id}; awaiting the user's confirmation button. Not executed.]`
    };
  }
  if (result.status === 'needs_clarification') {
    return {
      status: 'needs_clarification',
      data: { field: result.field, message: result.message, options: result.options.map((o) => o.label) },
      blocks: [{ type: 'choices', field: result.field, message: result.message, options: result.options.map((o) => ({ ...o, message: messageFor(o, result.field) })) }],
      context: `[Asked the user to choose ${result.field}: ${result.options.map((o) => `${o.label} = ${o.value}`).join(' | ')}]`
    };
  }
  if (result.status === 'needs_input') {
    return { status: 'needs_input', data: { missing: result.missing, message: result.message }, blocks: [] };
  }
  return {
    status: 'rejected',
    data: { code: result.code, message: result.message, ...(result.suggestions ? { savedBeneficiaries: result.suggestions } : {}), ...(result.dueBills ? { dueBills: result.dueBills } : {}) },
    blocks: [{ type: 'notice', tone: 'warning', title: 'Request not possible', message: result.message }]
  };
}

const rangeArgs = z.strictObject({ ...dateRangeShape }).superRefine(checkRange);

export const TOOLS = [
  {
    name: 'get_accounts',
    label: 'Checking your accounts',
    scope: 'accounts:read',
    description: 'Get all of the user\'s accounts with type, masked number, ledger balance, available balance (balance minus pending holds) and status. Use for any balance question.',
    schema: empty,
    run: ({ db, user }) => {
      const data = accounts.listAccounts(db, user.id);
      return ok(data, [{ type: 'accounts', ...data }], `[Accounts: ${data.accounts.map((a) => `${a.nickname} ${a.maskedNumber} (${a.id})`).join('; ')}]`);
    }
  },
  {
    name: 'search_transactions',
    label: 'Searching transactions',
    scope: 'transactions:read',
    description: 'List or search transactions. With no filters, returns the most recent transactions. Filter by free-text query, merchant, category, direction (debit = money out, credit = money in), status (success, pending, failed), channel, amount range, date range or account. Sort by date or amount.',
    schema: z.strictObject({
      query: shortText(60, 'Free text matched against description, merchant or bank reference.').optional(),
      merchant: shortText(60, 'Merchant or counterparty name, e.g. "Swiggy".').optional(),
      category: z.enum(ALL_CATEGORIES).optional(),
      direction: z.enum(['debit', 'credit']).optional(),
      status: z.enum(['success', 'pending', 'failed']).optional(),
      channel: z.enum(['upi', 'card', 'neft', 'imps', 'rtgs', 'netbanking', 'auto_debit', 'atm', 'internal']).optional(),
      minAmount: amount('Minimum amount in INR, e.g. "500".').optional(),
      maxAmount: amount('Maximum amount in INR.').optional(),
      ...dateRangeShape,
      account: shortText(40, 'Account nickname or last 4 digits.').optional(),
      sort: z.enum(['date_desc', 'date_asc', 'amount_desc', 'amount_asc']).optional(),
      limit: z.number().int().min(1).max(25).optional().describe('Max results (default 10).')
    }).superRefine(checkRange),
    run: ({ db, user }, args) => {
      let accountId;
      if (args.account) {
        const r = accounts.resolveAccount(db, user.id, args.account);
        if (r.status !== 'resolved') return { status: 'rejected', data: { message: 'Account not found or ambiguous.' }, blocks: [] };
        accountId = r.account.id;
      }
      const result = txns.searchTransactions(db, user.id, { ...args, accountId, minAmountPaise: args.minAmount, maxAmountPaise: args.maxAmount, limit: args.limit ?? 10 });
      return ok(result, [{ type: 'transactions', title: describeSearch(args), ...result }], txnContext(result.items));
    }
  },
  {
    name: 'explain_transaction',
    label: 'Looking into the transaction',
    scope: 'transactions:read',
    description: 'Explain one transaction: status meaning, failure reason, merchant history, duplicate check, any existing complaint, and suggested next steps. Requires the transaction id (e.g. txn_00042) or bank reference from an earlier result; search first if unknown.',
    schema: z.strictObject({ transactionId: shortText(40, 'Transaction id (txn_…) or bank reference number.') }),
    run: ({ db, user }, args) => {
      const data = txns.explainTransaction(db, user.id, args.transactionId);
      return ok(data, [{ type: 'transaction_detail', ...data }], txnContext([data.transaction], 'Transaction explained'));
    }
  },
  {
    name: 'get_spending_summary',
    label: 'Calculating your spending',
    scope: 'transactions:read',
    description: 'Total spending for a period with category breakdown, top merchants and daily average. Spending = successful debits in expense categories (excludes transfers, SIPs, pending, failed). Optionally limit to one category.',
    schema: z.strictObject({ ...dateRangeShape, category: z.enum(EXPENSE_CATEGORIES).optional() }).superRefine(checkRange),
    run: ({ db, user }, args) => {
      const data = analytics.spendingSummary(db, user.id, { period: 'this_month', ...args, ...(args.startDate || args.endDate ? { period: undefined } : {}) });
      return ok(data, [{ type: 'spending', ...data }]);
    }
  },
  {
    name: 'compare_spending',
    label: 'Comparing periods',
    scope: 'transactions:read',
    description: 'Compare spending between two periods (default this month to date vs last month), with per-category changes, the biggest drivers of any increase (with their largest transactions) and a like-for-like comparison against the same days of last month. Use for "compare" and "why did my expenses increase" questions.',
    schema: z.strictObject({ currentPeriod: period.optional(), previousPeriod: period.optional(), category: z.enum(EXPENSE_CATEGORIES).optional() }),
    run: ({ db, user }, args) => {
      const data = analytics.compareSpending(db, user.id, args);
      return ok(data, [{ type: 'comparison', ...data }], txnContext(data.drivers.flatMap((d) => d.largestTransactions), 'Driver transactions'));
    }
  },
  {
    name: 'get_top_transactions',
    label: 'Finding your largest transactions',
    scope: 'transactions:read',
    description: 'Largest successful transactions in a period, by amount. direction=debit for biggest expenses, credit for biggest incoming amounts.',
    schema: z.strictObject({ limit: z.number().int().min(1).max(20).optional(), direction: z.enum(['debit', 'credit']).optional(), ...dateRangeShape, category: z.enum(ALL_CATEGORIES).optional() }).superRefine(checkRange),
    run: ({ db, user }, args) => {
      const data = analytics.topTransactions(db, user.id, { ...args, period: args.startDate || args.endDate ? undefined : args.period ?? 'this_month' });
      return ok(data, [{ type: 'transactions', title: `Largest ${data.direction === 'credit' ? 'credits' : 'debits'} — ${data.range.label}`, items: data.items, total: data.items.length, ranked: true }], txnContext(data.items));
    }
  },
  {
    name: 'get_monthly_trend',
    label: 'Building your monthly trend',
    scope: 'transactions:read',
    description: 'Month-by-month income, spending, investments and transfers for the last N months (current month is month-to-date).',
    schema: z.strictObject({ months: z.number().int().min(2).max(12).optional() }),
    run: ({ db, user }, args) => {
      const data = analytics.monthlyTrend(db, user.id, args);
      return ok(data, [{ type: 'trend', ...data }]);
    }
  },
  {
    name: 'find_duplicate_charges',
    label: 'Checking for duplicate charges',
    scope: 'transactions:read',
    description: 'Detect duplicate-looking charges: same merchant and amount on the same account within 30 minutes. Default period: last 30 days.',
    schema: rangeArgs,
    run: ({ db, user }, args) => {
      const groups = txns.findDuplicateCharges(db, user.id, Object.keys(args).length ? args : { period: 'last_30_days' });
      return ok({ groups, count: groups.length }, [{ type: 'duplicates', groups }], txnContext(groups.flatMap((g) => g.transactions), 'Possible duplicates'));
    }
  },
  {
    name: 'find_unusual_spending',
    label: 'Looking for unusual spending',
    scope: 'transactions:read',
    description: 'Detect unusually large transactions, large first-time merchants and category spikes compared with the previous 90 days. Default: this month.',
    schema: rangeArgs,
    run: ({ db, user }, args) => {
      const data = txns.findUnusualSpending(db, user.id, Object.keys(args).length ? args : { period: 'this_month' });
      return ok(data, [{ type: 'unusual', ...data }], txnContext(data.largeTransactions.map((l) => l.transaction), 'Unusual transactions'));
    }
  },
  {
    name: 'get_recurring_payments',
    label: 'Reviewing subscriptions and mandates',
    scope: 'transactions:read',
    description: 'Subscriptions, standing instructions, SIPs and autopay mandates with amounts and next due dates, plus recurring charges detected from transaction history and subscriptions newly started this month.',
    schema: empty,
    run: ({ db, user }) => {
      const data = recurring.listRecurringPayments(db, user.id);
      return ok(data, [{ type: 'recurring', ...data }]);
    }
  },
  {
    name: 'get_upcoming_payments',
    label: 'Checking upcoming payments',
    scope: 'transactions:read',
    description: 'Upcoming recurring payments and due bills in the next N days (default 30).',
    schema: z.strictObject({ days: z.number().int().min(1).max(60).optional() }),
    run: ({ db, user }, args) => {
      const data = recurring.listUpcomingPayments(db, user.id, { untilDate: addDays(today(), args.days ?? 30) });
      return ok(data, [{ type: 'upcoming', ...data }]);
    }
  },
  {
    name: 'get_savings_capacity',
    label: 'Working out what you can save',
    scope: 'transactions:read',
    description: 'Calculate how much the user can safely save for the rest of this month, with the full breakdown (income, spent so far, committed upcoming payments, projected spending, safety buffer) and the assumptions used.',
    schema: empty,
    run: ({ db, user }) => {
      const data = analytics.savingsCapacity(db, user.id);
      return ok(data, [{ type: 'savings', ...data }]);
    }
  },
  {
    name: 'get_budgets',
    label: 'Checking your budgets',
    scope: 'transactions:read',
    description: 'Monthly category budgets with amount spent this month, remaining, percent used, projected month-end spend and status.',
    schema: empty,
    run: ({ db, user }) => {
      const data = budgets.listBudgets(db, user.id);
      return ok(data, [{ type: 'budgets', ...data }]);
    }
  },
  {
    name: 'set_budget',
    label: 'Updating your budget',
    scope: 'budgets:write',
    description: 'Create or update the monthly budget for one spending category. Only call when the user explicitly asks to set or change a budget amount.',
    schema: z.strictObject({ category: z.enum(EXPENSE_CATEGORIES), amount: amount('Monthly limit in INR, e.g. "8000".', { maxRupees: 1_000_000 }) }),
    run: ({ db, user }, args) => {
      const data = budgets.setBudget(db, user.id, { category: args.category, amountPaise: args.amount });
      return ok(data, [{ type: 'budgets', budgets: [data] }]);
    }
  },
  {
    name: 'list_beneficiaries',
    label: 'Loading saved beneficiaries',
    scope: 'accounts:read',
    description: 'List saved beneficiaries (payees) with bank and masked account number.',
    schema: empty,
    run: ({ db, user }) => {
      const items = beneficiaries.listBeneficiaries(db, user.id);
      return ok({ beneficiaries: items }, [{ type: 'beneficiaries', items }], `[Beneficiaries: ${items.map((b) => `${b.name} = ${b.id}`).join('; ')}]`);
    }
  },
  {
    name: 'prepare_transfer',
    label: 'Preparing the transfer',
    scope: 'payments:write',
    description: 'Validate and PREPARE a money transfer to a saved beneficiary or between the user\'s own accounts. This NEVER sends money: it returns needs_input, needs_clarification, rejected, or awaiting_confirmation with a preview card the user must confirm with a button. Call it as soon as the user expresses intent, even if details are missing; pass only what the user actually said. When the user picks an option from a clarification, call again with the chosen value.',
    schema: z.strictObject({
      recipient: shortText(80, 'Saved beneficiary name/nickname as the user said it, or a beneficiary id (ben_…) chosen from options.').optional(),
      toOwnAccount: shortText(40, 'For transfers between the user\'s own accounts: destination account nickname, last 4 digits or id.').optional(),
      amount: amount('Amount in INR exactly as the user stated, e.g. "2000" or "1499.50".').optional(),
      method: z.enum(['upi', 'imps', 'neft', 'rtgs']).optional().describe('Only if the user specified a payment method.'),
      fromAccount: shortText(40, 'Source account nickname, last 4 digits or id, only if the user specified it.').optional(),
      note: shortText(60, 'Optional remark for the payment.').optional()
    }).refine((v) => !(v.recipient && v.toOwnAccount), 'provide recipient or toOwnAccount, not both'),
    run: (ctx, args) => preparedEnvelope(ctx, 'transfer', transfers.prepareTransfer(ctx.db, ctx.user.id, {
      recipient: args.recipient, toAccount: args.toOwnAccount, amountPaise: args.amount, method: args.method, fromAccount: args.fromAccount, note: args.note
    }), (option, field) => {
      const amt = args.amount != null ? `${money(args.amount).formatted} ` : 'money ';
      const via = args.method ? ` via ${args.method.toUpperCase()}` : '';
      if (field === 'recipient') return `Send ${amt}to ${option.label}${args.fromAccount ? ` from ${args.fromAccount}` : ''}${via}`;
      if (field === 'toAccount') return `Move ${amt}to my ${option.label}`;
      return `Send ${amt}to ${args.recipient ?? `my ${args.toOwnAccount}`} from ${option.label}${via}`;
    })
  },
  {
    name: 'list_bills',
    label: 'Checking your bills',
    scope: 'accounts:read',
    description: 'List the user\'s bills (due and paid) from registered billers.',
    schema: empty,
    run: ({ db, user }) => {
      const items = bills.listBills(db, user.id);
      return ok({ bills: items }, [{ type: 'bills', items }]);
    }
  },
  {
    name: 'prepare_bill_payment',
    label: 'Preparing the bill payment',
    scope: 'payments:write',
    description: 'PREPARE payment of a due bill (never pays directly). The user must confirm on the card. Pass the biller name as the user said it (e.g. "electricity", "Jio") or a bill id.',
    schema: z.strictObject({ bill: shortText(60, 'Biller name or bill id.').optional(), fromAccount: shortText(40, 'Source account, only if specified.').optional() }),
    run: (ctx, args) => preparedEnvelope(ctx, 'bill_payment', bills.prepareBillPayment(ctx.db, ctx.user.id, args), (o, field) => (field === 'bill' ? `Pay the ${o.label.split(' — ')[0]} bill` : `Pay the ${args.bill} bill from ${o.label}`))
  },
  {
    name: 'get_cards',
    label: 'Checking your cards',
    scope: 'accounts:read',
    description: 'List the user\'s debit cards with status (active, temporarily blocked, permanently blocked), limits and linked account.',
    schema: empty,
    run: ({ db, user }) => {
      const items = cards.listCards(db, user.id);
      return ok({ cards: items }, [{ type: 'cards', items }]);
    }
  },
  {
    name: 'prepare_card_block',
    label: 'Preparing the card block',
    scope: 'cards:write',
    description: 'PREPARE blocking a debit card (never blocks directly); the user must confirm. reason: lost, stolen, suspicious_activity or damaged = permanent block; temporary = reversible (default when no reason is given). If the user says the card is lost or stolen, pass that reason.',
    schema: z.strictObject({ card: shortText(40, 'Card last 4 digits, variant or linked account, if specified.').optional(), reason: z.enum(cards.BLOCK_REASONS).optional() }),
    run: (ctx, args) => preparedEnvelope(ctx, 'card_block', cards.prepareCardBlock(ctx.db, ctx.user.id, args), (o) => `Block my card ••${o.label.match(/••(\d{4})/)?.[1]}${args.reason ? ` (${args.reason.replace('_', ' ')})` : ''}`)
  },
  {
    name: 'prepare_card_unblock',
    label: 'Preparing the card unblock',
    scope: 'cards:write',
    description: 'PREPARE unblocking a temporarily blocked card (never unblocks directly); the user must confirm.',
    schema: z.strictObject({ card: shortText(40, 'Card last 4 digits or variant, if specified.').optional() }),
    run: (ctx, args) => preparedEnvelope(ctx, 'card_unblock', cards.prepareCardUnblock(ctx.db, ctx.user.id, args), (o) => `Unblock my card ••${o.label.match(/••(\d{4})/)?.[1]}`)
  },
  {
    name: 'open_add_beneficiary_form',
    label: 'Opening the beneficiary form',
    scope: 'beneficiaries:write',
    description: 'Show a secure form where the user enters a new beneficiary\'s details directly. Use this whenever the user wants to add a payee. Never ask the user to type account numbers in chat.',
    schema: z.strictObject({ name: shortText(60, 'Beneficiary name if the user mentioned it.').optional() }),
    run: (_ctx, args) => ok({ formShown: true, note: 'The user fills the form in the app; details are not shared with the assistant.' }, [{ type: 'form', form: 'add_beneficiary', prefill: { name: args.name ?? '' } }])
  },
  {
    name: 'search_help_articles',
    label: 'Checking the help centre',
    scope: 'accounts:read',
    description: 'Search Northstar\'s help centre for policies, timelines and procedures (failed/pending UPI, refunds, duplicate charges, card blocking, disputes, transfer limits, escalation, security). Use before answering any FAQ or policy question, and base the answer only on the returned articles.',
    schema: z.strictObject({ query: shortText(120, 'Topic to search for.') }),
    run: (_ctx, args) => {
      const data = support.searchHelpArticles(args.query);
      return ok(data, data.found ? [{ type: 'help', articles: data.articles.map((a) => ({ id: a.id, title: a.title })) }] : []);
    }
  },
  {
    name: 'raise_complaint',
    label: 'Registering your complaint',
    scope: 'support:write',
    description: 'Register a support complaint and get a reference number. Only call after the user has agreed to raise a complaint. Link the transaction id when the issue concerns a specific transaction. If an open complaint already exists for that transaction, it is returned instead of creating a duplicate.',
    schema: z.strictObject({
      category: z.enum(Object.keys(support.COMPLAINT_CATEGORIES)),
      transactionId: shortText(40, 'Related transaction id (txn_…) or reference.').optional(),
      description: z.string().trim().min(10).max(500).describe('Short description of the issue in the user\'s words.')
    }),
    run: ({ db, user }, args) => {
      const data = support.createComplaint(db, user.id, args);
      return ok(data, [{ type: 'complaint', complaint: data }], `[Complaint ${data.reference} (${data.status})]`);
    }
  },
  {
    name: 'get_complaints',
    label: 'Checking complaint status',
    scope: 'accounts:read',
    description: 'Track complaints: with a reference (CMP-…) returns that complaint with its timeline; without, lists all complaints.',
    schema: z.strictObject({ reference: shortText(30, 'Complaint reference, e.g. CMP-104233.').optional() }),
    run: ({ db, user }, args) => {
      if (args.reference) {
        const c = support.getComplaint(db, user.id, args.reference);
        return ok(c, [{ type: 'complaint', complaint: c }], `[Complaint ${c.reference} (${c.status})]`);
      }
      const items = support.listComplaints(db, user.id);
      return ok({ complaints: items }, [{ type: 'complaints', items }], `[Complaints: ${items.map((c) => `${c.reference} ${c.status}`).join('; ')}]`);
    }
  },
  {
    name: 'escalate_complaint',
    label: 'Escalating your complaint',
    scope: 'support:write',
    description: 'Escalate an open complaint to a senior grievance officer (use when it is overdue, the user is unhappy with progress, or asks for a human). Returns helpline and escalation contacts.',
    schema: z.strictObject({ reference: shortText(30, 'Complaint reference, e.g. CMP-104233.'), reason: shortText(200, 'Why the user wants to escalate.').optional() }),
    run: ({ db, user }, args) => {
      const c = support.escalateComplaint(db, user.id, args);
      return ok(c, [{ type: 'complaint', complaint: c, escalation: c.contact }], `[Complaint ${c.reference} escalated]`);
    }
  }
];

function describeSearch(args) {
  const parts = [];
  if (args.status) parts.push(args.status);
  if (args.category) parts.push(args.category);
  if (args.direction) parts.push(args.direction === 'debit' ? 'debits' : 'credits');
  if (args.merchant || args.query) parts.push(`matching "${args.merchant ?? args.query}"`);
  if (args.period) parts.push(args.period.replaceAll('_', ' '));
  if (args.startDate || args.endDate) parts.push(`${args.startDate ?? '…'} → ${args.endDate ?? '…'}`);
  return parts.length ? `Transactions · ${parts.join(' · ')}` : 'Recent transactions';
}

export const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));
