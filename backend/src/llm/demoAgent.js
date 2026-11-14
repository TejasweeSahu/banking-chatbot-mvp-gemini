/**
 * Offline fallback used when GEMINI_API_KEY is not set (and in end-to-end
 * tests). A deterministic keyword router — not an LLM — that drives the same
 * validated tool registry, so every banking workflow works without Gemini.
 * Replies are templated strictly from tool results.
 */

import { executeTool, toolLabel } from '../tools/executor.js';
import { EXPENSE_CATEGORIES } from '../tools/schemas.js';

const CATEGORY_WORDS = {
  food: ['food', 'eating out', 'restaurant', 'dining', 'swiggy', 'zomato'],
  groceries: ['grocery', 'groceries'],
  transport: ['transport', 'travel by cab', 'uber', 'ola', 'fuel', 'cab'],
  shopping: ['shopping', 'amazon', 'flipkart', 'myntra'],
  bills: ['bills', 'utilities', 'electricity'],
  subscriptions: ['subscription'],
  entertainment: ['entertainment', 'movies'],
  health: ['health', 'pharmacy', 'medical'],
  travel: ['travel', 'flight'],
  rent: ['rent']
};

function detectCategory(text) {
  for (const cat of EXPENSE_CATEGORIES) if ((CATEGORY_WORDS[cat] ?? [cat]).some((w) => text.includes(w))) return cat;
  return undefined;
}

function detectPeriod(text) {
  if (/last month|previous month/.test(text)) return 'last_month';
  if (/last 7 days|this week|past week/.test(text)) return 'last_7_days';
  if (/last 30 days|past month/.test(text)) return 'last_30_days';
  if (/last 90 days|last 3 months|quarter/.test(text)) return 'last_90_days';
  if (/this year/.test(text)) return 'this_year';
  return undefined;
}

function parseTransfer(original) {
  const text = original.replace(/\s+/g, ' ').trim();
  const toIdx = text.search(/\bto\b/i);
  const head = toIdx >= 0 ? text.slice(0, toIdx) : text;
  const amountMatch = head.match(/(?:₹|rs\.?|inr)?\s*(\d[\d,]*(?:\.\d{1,2})?)\s*(k\b)?/i);
  let amount;
  if (amountMatch) amount = amountMatch[2] ? String(Number(amountMatch[1].replace(/,/g, '')) * 1000) : amountMatch[1].replace(/,/g, '');
  const recipientMatch = text.match(/\bto\s+(.+?)(?:\s+(?:from|via|using|through)\b|[?!]|$)/i);
  const fromMatch = text.match(/\bfrom\s+(?:my\s+)?(.+?)(?:\s+(?:via|using|through)\b|[?!]|$)/i);
  const method = text.match(/\b(upi|imps|neft|rtgs)\b/i)?.[1]?.toLowerCase();
  let recipient = recipientMatch?.[1]?.trim().replace(/^my\s+/i, '');
  let toOwnAccount;
  if (recipient && /(family savings|everyday savings|savings account|my account|\b\d{4}\b.*account)/i.test(recipient) && !/[—]/.test(recipient)) {
    toOwnAccount = recipient;
    recipient = undefined;
  }
  return { amount, recipient, toOwnAccount, method, fromAccount: fromMatch?.[1]?.trim() };
}

function route(message) {
  const text = message.toLowerCase();
  if (/\b(unblock|reactivate|activate)\b.*\bcard\b|\bcard\b.*\bunblock/.test(text)) return [['prepare_card_unblock', cardArgs(text)]];
  if (/\b(block|freeze|lost|stolen)\b.*\bcard\b|\bcard\b.*\b(block|freeze|lost|stolen)/.test(text)) {
    const args = cardArgs(text);
    const reason = /stolen/.test(text) ? 'stolen' : /lost/.test(text) ? 'lost' : /suspicious|fraud/.test(text) ? 'suspicious_activity' : /damaged/.test(text) ? 'damaged' : undefined;
    return [['prepare_card_block', { ...args, ...(reason ? { reason } : {}) }]];
  }
  if (/\badd\b.*\b(beneficiary|payee)\b|\bnew (beneficiary|payee)\b/.test(text)) return [['open_add_beneficiary_form', {}]];
  if (/\bpay\b.*\bbill\b|\bbill\b.*\bpay\b/.test(text)) {
    const bill = text.match(/\b(electricity|tpcodl|jio|airtel|mobile|postpaid)\b/)?.[1];
    return [['prepare_bill_payment', bill ? { bill: bill === 'mobile' || bill === 'postpaid' ? 'jio' : bill } : {}]];
  }
  if (/\b(send|transfer|pay|move)\b/.test(text) && !/\bhow\b/.test(text)) {
    const p = parseTransfer(message);
    return [['prepare_transfer', Object.fromEntries(Object.entries(p).filter(([, v]) => v))]];
  }
  if (/\bescalat/.test(text)) {
    const ref = message.match(/CMP-\d{6}/i)?.[0];
    return ref ? [['escalate_complaint', { reference: ref.toUpperCase() }]] : [['get_complaints', {}]];
  }
  if (/\bcomplaint|ticket\b/.test(text) && /\b(raise|register|file|lodge)\b/.test(text) && /duplicate/.test(text)) return [['find_duplicate_charges', {}]];
  if (/\b(complaint|ticket|cmp-)/.test(text)) {
    const ref = message.match(/CMP-\d{6}/i)?.[0];
    return [['get_complaints', ref ? { reference: ref.toUpperCase() } : {}]];
  }
  if (/duplicate|charged twice|double charge/.test(text)) return [['find_duplicate_charges', {}]];
  if (/unusual|suspicious|strange|anomal/.test(text)) return [['find_unusual_spending', {}]];
  if (/\b(failed|pending|stuck|refund|reversal|deducted)\b/.test(text)) {
    const status = /refund/.test(text) ? undefined : /pending|stuck/.test(text) ? 'pending' : 'failed';
    const calls = [['search_help_articles', { query: message.slice(0, 120) }]];
    if (status) calls.push(['search_transactions', { status, period: 'last_30_days' }]);
    else calls.push(['search_transactions', { category: 'refunds', period: 'last_90_days' }]);
    return calls;
  }
  if (/\b(why|increase|more than|higher)\b.*\b(spend|expense|spent)|\bcompare|\bvs\b|versus/.test(text)) return [['compare_spending', detectCategory(text) ? { category: detectCategory(text) } : {}]];
  if (/\b(largest|biggest|top|highest)\b/.test(text)) {
    const limit = Number(text.match(/\b(\d{1,2})\b/)?.[1] ?? (/\bfive\b/.test(text) ? 5 : /\bthree\b/.test(text) ? 3 : 5));
    return [['get_top_transactions', { limit: Math.min(Math.max(limit, 1), 20), ...(detectPeriod(text) ? { period: detectPeriod(text) } : {}) }]];
  }
  if (/subscription|recurring|standing instruction|mandate|autopay|sip\b/.test(text)) return [['get_recurring_payments', {}]];
  if (/upcoming|due\b|coming up|next week|next 7/.test(text)) return [['get_upcoming_payments', /7 days|week/.test(text) ? { days: 7 } : {}]];
  if (/\bsave\b|saving capacity|safely/.test(text)) return [['get_savings_capacity', {}]];
  if (/\bset\b.*\bbudget\b/.test(text)) {
    const amount = message.match(/(\d[\d,]*(?:\.\d{1,2})?)/)?.[1]?.replace(/,/g, '');
    return [['set_budget', { category: detectCategory(text), amount }]];
  }
  if (/budget/.test(text)) return [['get_budgets', {}]];
  if (/trend|month by month|monthly|over time|income/.test(text)) return [['get_monthly_trend', {}]];
  if (/\b(spend|spent|spending|expense|expenses)\b/.test(text)) {
    const args = {};
    const category = detectCategory(text);
    if (category) args.category = category;
    const period = detectPeriod(text);
    if (period) args.period = period;
    return [['get_spending_summary', args]];
  }
  if (/balance|how much (money )?(do i have|is in)|accounts?\b/.test(text)) return [['get_accounts', {}]];
  if (/beneficiar|payees?\b/.test(text)) return [['list_beneficiaries', {}]];
  if (/\bcards?\b/.test(text)) return [['get_cards', {}]];
  if (/\bbills?\b/.test(text)) return [['list_bills', {}]];
  if (/\b(transactions?|statement|history|payments?|purchases?)\b/.test(text)) {
    const n = Number(text.match(/\b(?:last|latest|recent)\s+(\d{1,2})\b/)?.[1] ?? 10);
    const args = { limit: Math.min(Math.max(n, 1), 25) };
    const category = detectCategory(text);
    if (category) args.category = category;
    const merchant = message.match(/\b(swiggy|zomato|uber|ola|amazon|flipkart|myntra|netflix|spotify|croma|bigbasket)\b/i)?.[1];
    if (merchant) { args.merchant = merchant; delete args.category; }
    if (/\bcard\b/.test(text)) args.channel = 'card';
    const period = detectPeriod(text);
    if (period) args.period = period;
    return [['search_transactions', args]];
  }
  if (/how|what|policy|limit|timeline|otp|pin/.test(text)) return [['search_help_articles', { query: message.slice(0, 120) }]];
  return [];
}

function cardArgs(text) {
  const last4 = text.match(/\b(\d{4})\b/)?.[1];
  if (last4) return { card: last4 };
  if (/family|rupay/.test(text)) return { card: 'family' };
  if (/everyday|visa|debit card/.test(text) && !/family/.test(text)) return /\bdebit card\b/.test(text) && !/everyday|visa/.test(text) ? {} : { card: 'everyday' };
  return {};
}

function reply(name, env) {
  const d = env.data ?? {};
  if (env.status === 'error') return d.code === 'forbidden' ? 'Your profile has read-only access, so I can\'t do that. I can still show balances, transactions and insights.' : `I couldn't do that: ${d.issues?.map((i) => `${i.field} ${i.problem}`).join('; ') ?? d.message}`;
  if (env.status === 'needs_input') return d.message;
  if (env.status === 'needs_clarification') return `${d.message} Tap one of the options below.`;
  if (env.status === 'rejected') return d.message;
  if (env.status === 'awaiting_confirmation') {
    const p = d.preview;
    if (d.type === 'transfer') return `I've prepared a transfer of **${p.amount.formatted}** to **${p.to.name}** (${p.to.bankName} ${p.to.maskedAccount}) via ${p.methodLabel}. Nothing has been sent yet. Review the details and choose **Send money** to go ahead.`;
    if (d.type === 'bill_payment') return `Your ${p.bill.biller} bill of **${p.amount.formatted}** is ready to pay from ${p.from.nickname} ${p.from.maskedNumber}. Choose **Pay bill** to pay it.`;
    if (d.type === 'card_block') return `Ready to ${p.permanent ? 'permanently' : 'temporarily'} block your ${p.card.variant} ending **${p.card.last4}**. ${p.consequence} Choose **Block card** to continue.`;
    if (d.type === 'card_unblock') return `Ready to unblock your ${p.card.variant} ending **${p.card.last4}**. Choose **Unblock card** to continue.`;
  }
  switch (name) {
    case 'get_accounts': return `Your total balance across ${d.accountCount} accounts is **${d.totalBalance.formatted}**, with **${d.totalAvailable.formatted}** available to spend. ${d.accounts.filter((a) => a.holds.paise > 0).map((a) => `${a.nickname} has ${a.holds.formatted} on hold for pending payments.`).join(' ')}`.trim();
    case 'search_transactions': return d.total ? `Here ${d.total === 1 ? 'is' : 'are'} ${d.returned === d.total ? d.total : `the latest ${d.returned} of ${d.total}`} matching transaction${d.total === 1 ? '' : 's'}.` : 'I didn\'t find any matching transactions.';
    case 'get_spending_summary': return `You spent **${d.total.formatted}**${d.category ? ` on ${d.category.label.toLowerCase()}` : ''} in ${d.range.label} across ${d.transactionCount} transactions${!d.category && d.byCategory[0] ? `. Your biggest category was ${d.byCategory[0].category.label} at ${d.byCategory[0].total.formatted}` : ''}.`;
    case 'compare_spending': {
      const up = d.change.paise >= 0;
      const lfl = d.likeForLike ? ` Compared with the same days of last month (${d.likeForLike.total.formatted}), that's ${d.likeForLike.change.paise >= 0 ? 'up' : 'down'} ${d.likeForLike.change.formatted.replace('-', '')}.` : '';
      const drivers = d.drivers.length ? ` The biggest increases: ${d.drivers.map((x) => `${x.category.label} (+${x.change.formatted})`).join(', ')}.` : '';
      return `You've spent **${d.current.total.formatted}** in ${d.current.range.label} vs **${d.previous.total.formatted}** in ${d.previous.range.label} — ${up ? 'up' : 'down'} ${d.change.formatted.replace('-', '')}${d.changePct != null ? ` (${Math.abs(d.changePct)}%)` : ''}.${lfl}${drivers}`;
    }
    case 'get_top_transactions': return d.items.length ? `Your ${d.items.length} largest ${d.direction === 'credit' ? 'credits' : 'debits'} in ${d.range.label} total **${d.total.formatted}**. The largest was ${d.items[0].merchant} at ${d.items[0].amount.formatted}.` : 'No transactions in that period.';
    case 'get_monthly_trend': return 'Here is your month-by-month income and spending.';
    case 'find_duplicate_charges': return d.count ? `I found ${d.count} possible duplicate charge${d.count > 1 ? 's' : ''}: ${d.groups.map((g) => `${g.merchant} ${g.amount.formatted} × ${g.count}`).join(', ')}. If you didn't place the order twice, I can raise a complaint.` : 'No duplicate-looking charges in the last 30 days.';
    case 'find_unusual_spending': return d.largeTransactions.length || d.categorySpikes.length ? `I flagged ${d.largeTransactions.length} unusual transaction${d.largeTransactions.length === 1 ? '' : 's'}${d.categorySpikes.length ? ` and higher-than-usual spending on ${d.categorySpikes.map((c) => c.category.label).join(', ')}` : ''}.` : 'Nothing unusual stands out this month.';
    case 'get_recurring_payments': return `You have ${d.subscriptions.length} active subscriptions costing **${d.subscriptionMonthlyTotal.formatted}** a month${d.newThisMonth.length ? ` — ${d.newThisMonth.join(', ')} started this month` : ''}. Total monthly commitments, including rent and SIPs, are ${d.monthlyCommitted.formatted}.`;
    case 'get_upcoming_payments': return d.items.length ? `${d.items.length} payments totalling **${d.total.formatted}** are due by ${d.untilDate}. The next is ${d.items[0].name} (${d.items[0].amount.formatted}) on ${d.items[0].dueDate}.` : 'Nothing is due in that window.';
    case 'get_savings_capacity': return d.safeToSave.paise > 0 ? `You can safely set aside about **${d.safeToSave.formatted}** more this month. That's after what you've spent, ${d.breakdown.committedUpcoming.formatted} of upcoming bills, projected day-to-day spending and a 10% safety buffer.` : `I wouldn't recommend extra savings this month — projected spending exceeds income by ${d.shortfall?.formatted ?? '₹0.00'} after a safety buffer.`;
    case 'get_budgets': {
      const over = d.budgets.filter((b) => b.status === 'exceeded');
      return over.length ? `You've exceeded ${over.length} budget${over.length > 1 ? 's' : ''}: ${over.map((b) => `${b.category.label} (over by ${b.overBy.formatted})`).join(', ')}.` : 'All your budgets are within limits so far.';
    }
    case 'set_budget': return `Your ${d.category.label} budget is now ${d.limit.formatted} a month (${d.percentUsed}% used so far).`;
    case 'list_beneficiaries': return `You have ${d.beneficiaries.length} saved beneficiaries.`;
    case 'list_bills': return `You have ${d.bills.filter((b) => b.status === 'due').length} bills due.`;
    case 'get_cards': return d.cards.map((c) => `${c.variant} ••${c.last4}: ${c.statusLabel}`).join('. ') + '.';
    case 'open_add_beneficiary_form': return 'Enter the new beneficiary\'s details in the secure form below. They\'re sent straight to the bank, not to the chat.';
    case 'search_help_articles': return d.found ? `${d.articles[0].content}` : 'I couldn\'t find a help article on that. I can raise a complaint, or you can call the helpline.';
    case 'raise_complaint': return d.alreadyExisted ? `There's already an open complaint for this: ${d.reference}.` : `Complaint **${d.reference}** is registered. Target resolution: ${d.slaDueDate}.`;
    case 'get_complaints': return d.reference ? `Complaint ${d.reference} is **${d.status.replace('_', ' ')}**${d.overdue ? ' and past its target date — I can escalate it' : ` (target ${d.slaDueDate})`}.` : d.complaints.length ? `You have ${d.complaints.length} complaint${d.complaints.length > 1 ? 's' : ''}. ${d.complaints.map((c) => `${c.reference}: ${c.status.replace('_', ' ')}`).join('; ')}.` : 'You have no complaints on record.';
    case 'escalate_complaint': return `Complaint ${d.reference} has been escalated to a senior grievance officer. You can also call ${d.contact.helpline}.`;
    case 'explain_transaction': return `${d.transaction.merchant} — ${d.transaction.amount.formatted} on ${d.transaction.date}: ${d.statusExplanation}`;
    default: return 'Done.';
  }
}

export function runDemoAgent({ ctx, message, emit, onTool }) {
  const calls = route(message);
  if (!calls.length) {
    return 'I can help with balances, transactions, spending insights, budgets, subscriptions, transfers, bill payments, cards and support. Try one of the suggestions below. (Demo mode: set GEMINI_API_KEY for full natural-language understanding.)';
  }
  const replies = [];
  for (const [name, args] of calls) {
    emit('tool_start', { name, label: toolLabel(name) });
    const env = executeTool(ctx, name, args);
    emit('tool_end', { name, status: env.status, durationMs: env.durationMs });
    onTool(name, args, env);
    replies.push(reply(name, env));
  }
  return replies.join('\n\n');
}
