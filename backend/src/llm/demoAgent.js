/**
 * @file backend/src/llm/demoAgent.js
 * @description Deterministic rule-based fallback agent for local assessment and offline demos.
 * Uses regex intent parsing and entity extraction (amounts, categories, beneficiaries) to map
 * natural language banking queries directly to the validated tool registry without requiring
 * external LLM API credentials.
 */

import { validateAndRunTool } from '../tools/bankingTools.js';

function parseAmount(text) {
  const match = text.replace(/,/g, '').match(/(?:₹|rs\.?\s*)?(\d+(?:\.\d{1,2})?)/i);
  return match ? Number(match[1]) : null;
}

function inferCategory(text) {
  const value = text.toLowerCase();
  const options = ['food', 'transport', 'shopping', 'bills', 'entertainment'];
  return options.find((item) => value.includes(item)) ?? null;
}

export function runDemoAgent(text) {
  const value = text.toLowerCase();
  let name;
  let args = {};
  let answer;

  if (/\b(balance|available balance|account balance)\b/.test(value)) {
    name = 'get_balance';
    answer = (data) => `Your current account balance is ₹${data.balance.toLocaleString('en-IN', { minimumFractionDigits: 2 })}. (Account ending ${data.accountLast4})`;
  } else if (/\b(block|freeze|disable)\b/.test(value) && /\b(card|debit)\b/.test(value)) {
    name = 'block_card';
    answer = () => 'Blocking your debit card requires confirmation. Review the card details below and confirm to continue.';
  } else if (/\b(transfer|send|pay)\b/.test(value)) {
    name = 'transfer_money';
    args.amount = parseAmount(text);
    const recipientMatch = text.match(/\bto\s+([a-z][a-z ]{0,40})/i);
    args.recipient = recipientMatch?.[1]?.trim().replace(/[?.!,].*$/, '') ?? '';
    if (!args.amount || !args.recipient) {
      return { text: 'Please specify both the amount and the saved beneficiary. Example: “Transfer ₹5000 to Rahul”.', pending: [] };
    }
    answer = () => 'This transfer is not complete yet. Review the details and confirm below to execute it.';
  } else if (/\b(spend|spent|spending|expense|expenses)\b/.test(value)) {
    name = 'get_spending_summary';
    args.period = /last\s+month|previous\s+month/.test(value) ? 'last_month' : /last\s+30\s+days/.test(value) ? 'last_30_days' : 'this_month';
    args.category = inferCategory(value) ?? undefined;
    answer = (data) => {
      const categoryText = data.category === 'all' ? 'all categories' : data.category;
      return `You spent ₹${data.total.toLocaleString('en-IN', { minimumFractionDigits: 2 })} on ${categoryText} during ${data.startDate} to ${data.endDate} (${data.transactionCount} transactions).`;
    };
  } else if (/\b(search|find|filter)\b/.test(value) || inferCategory(value)) {
    name = 'search_transactions';
    args.category = inferCategory(value) ?? undefined;
    args.query = /swiggy|zomato|uber|amazon|airtel/i.test(text) ? text.match(/swiggy|zomato|uber|amazon|airtel/i)[0] : undefined;
    answer = (data) => formatTransactions(data, 'I found these matching transactions:');
  } else if (/\b(transaction|transactions|statement|payments)\b/.test(value)) {
    name = 'get_transactions';
    const count = text.match(/\b(last|latest|recent)\s+(\d+)\b/i);
    args.limit = count ? Math.min(50, Math.max(1, Number(count[2]))) : 5;
    answer = (data) => formatTransactions(data, `Here are your ${data.length} most recent transactions:`);
  } else {
    return { text: 'I can help with your balance, recent or filtered transactions, spending summary, transfers, and debit card blocking. Try asking one of those.', pending: [] };
  }

  try {
    const result = validateAndRunTool(name, args);
    if (result.kind === 'pending') {
      return { text: answer(result.action), pending: [result.action] };
    }
    return { text: answer(result.data), pending: [] };
  } catch (error) {
    return { text: error.message, pending: [] };
  }
}

function formatTransactions(data, heading) {
  if (!data.length) return `${heading}\nNo matching transactions found.`;
  const rows = data.map((txn) => {
    const sign = txn.type === 'credit' ? '+' : '-';
    return `• ${txn.date} | ${txn.description} | ${sign}₹${txn.amount.toLocaleString('en-IN')} | ${txn.category}`;
  });
  return `${heading}\n${rows.join('\n')}`;
}
