/**
 * @file backend/src/services/bankingService.js
 * @description Manages mock banking business logic and in-memory transactional state.
 * Implements read operations (balance lookups, transaction listings, filtered searches, and
 * spending summaries) as well as the two-phase lifecycle for sensitive operations:
 * - Preparation phase (`prepareTransfer`, `prepareBlockCard`): validates constraints and creates pending drafts without mutating state.
 * - Execution phase (`executeTransfer`, `executeBlockCard`): performs actual balance deductions, record logging, and card freezing.
 */

import { randomUUID } from 'node:crypto';
import { MOCK_USER, MOCK_TRANSACTIONS, MOCK_RECIPIENTS } from '../data/mockData.js';

const user = structuredClone(MOCK_USER);
const transactions = structuredClone(MOCK_TRANSACTIONS);

const roundMoney = (value) => Math.round((value + Number.EPSILON) * 100) / 100;

export function getBalance() {
  return {
    balance: roundMoney(user.balance),
    currency: user.currency,
    accountLast4: user.accountLast4
  };
}

export function getTransactions({ limit = 5 } = {}) {
  return transactions
    .slice()
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, limit);
}

export function searchTransactions(filters = {}) {
  const query = filters.query?.trim().toLowerCase();
  return transactions
    .filter((txn) => {
      if (query && !`${txn.description} ${txn.merchant} ${txn.category}`.toLowerCase().includes(query)) return false;
      if (filters.category && txn.category !== filters.category) return false;
      if (filters.type && txn.type !== filters.type) return false;
      if (filters.startDate && txn.date < filters.startDate) return false;
      if (filters.endDate && txn.date > filters.endDate) return false;
      return true;
    })
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, filters.limit ?? 20);
}

function getPeriodRange(period) {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  if (period === 'last_month') {
    const start = new Date(year, month - 1, 1);
    const end = new Date(year, month, 0);
    return { startDate: toIsoDate(start), endDate: toIsoDate(end) };
  }
  if (period === 'last_30_days') {
    const end = new Date(year, month, now.getDate());
    const start = new Date(end);
    start.setDate(start.getDate() - 29);
    return { startDate: toIsoDate(start), endDate: toIsoDate(end) };
  }
  return {
    startDate: toIsoDate(new Date(year, month, 1)),
    endDate: toIsoDate(now)
  };
}

function toIsoDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function getSpendingSummary({ period = 'this_month', category } = {}) {
  const range = getPeriodRange(period);
  const matching = transactions.filter((txn) => {
    return txn.type === 'debit' && txn.date >= range.startDate && txn.date <= range.endDate && (!category || txn.category === category);
  });
  const total = roundMoney(matching.reduce((sum, txn) => sum + txn.amount, 0));
  const byCategory = matching.reduce((acc, txn) => {
    acc[txn.category] = roundMoney((acc[txn.category] ?? 0) + txn.amount);
    return acc;
  }, {});
  return { period, ...range, category: category ?? 'all', total, transactionCount: matching.length, byCategory };
}

export function prepareTransfer({ amount, recipient }) {
  const person = MOCK_RECIPIENTS[recipient.toLowerCase()];
  if (!person) {
    throw new Error(`I could not find ${recipient} in your saved beneficiaries.`);
  }
  if (amount > user.balance) {
    throw new Error('Insufficient balance for this transfer.');
  }
  return {
    type: 'transfer',
    amount: roundMoney(amount),
    recipient: person.name,
    recipientAccountLast4: person.accountLast4,
    sourceAccountLast4: user.accountLast4
  };
}

export function executeTransfer(action) {
  // Re-check the balance at execution time. The LLM never calls this directly.
  if (action.amount > user.balance) {
    throw new Error('Insufficient balance. Your balance may have changed.');
  }
  user.balance = roundMoney(user.balance - action.amount);
  const txn = {
    id: `txn-${randomUUID().slice(0, 8)}`,
    date: toIsoDate(new Date()),
    description: `Transfer to ${action.recipient}`,
    merchant: action.recipient,
    category: 'transfers',
    type: 'debit',
    amount: action.amount
  };
  transactions.unshift(txn);
  return {
    message: `₹${action.amount.toLocaleString('en-IN')} was transferred to ${action.recipient}.`,
    reference: txn.id,
    balance: getBalance()
  };
}

export function prepareBlockCard() {
  if (user.cardBlocked) {
    throw new Error('Your debit card is already blocked.');
  }
  return { type: 'block_card', cardLast4: user.cardLast4 };
}

export function executeBlockCard() {
  if (user.cardBlocked) throw new Error('Your debit card is already blocked.');
  user.cardBlocked = true;
  return { message: `Debit card ending ${user.cardLast4} has been blocked.`, cardLast4: user.cardLast4, blocked: true };
}

export function getCardStatus() {
  return { cardLast4: user.cardLast4, blocked: user.cardBlocked };
}

export function resetMockState() {
  // Test helper. The service is reset by process restart for a normal demo.
  user.balance = MOCK_USER.balance;
  user.cardBlocked = false;
  transactions.splice(0, transactions.length, ...structuredClone(MOCK_TRANSACTIONS));
}
