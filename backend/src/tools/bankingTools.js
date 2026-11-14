/**
 * @file backend/src/tools/bankingTools.js
 * @description Central registry of callable banking tools, function schemas, and argument validators.
 * Defines the 6 core tools (`get_balance`, `get_transactions`, `search_transactions`,
 * `get_spending_summary`, `transfer_money`, `block_card`), enforces strict server-side schema
 * validations, exports Gemini OpenAPI-compliant function declarations, and dispatches tool execution
 * based on whether the action is read-only or sensitive/pending.
 */

import * as bank from '../services/bankingService.js';

const categories = ['food', 'transport', 'shopping', 'bills', 'income', 'entertainment', 'transfers'];
const spendingCategories = categories.filter((item) => item !== 'income');
const periods = ['this_month', 'last_month', 'last_30_days'];
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

function objectArgs(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Arguments must be a JSON object.');
  return value;
}

function allowOnly(args, allowed) {
  const unknown = Object.keys(args).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`Unknown argument(s): ${unknown.join(', ')}.`);
}

function validateLimit(value) {
  if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > 50)) throw new Error('limit must be an integer from 1 to 50.');
}

function validateDate(value, field) {
  if (value !== undefined && (typeof value !== 'string' || !datePattern.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)))) {
    throw new Error(`${field} must be a valid date in YYYY-MM-DD format.`);
  }
}

function validateEnum(value, options, field) {
  if (value !== undefined && !options.includes(value)) throw new Error(`${field} must be one of: ${options.join(', ')}.`);
}

const emptySchema = (input) => {
  const args = objectArgs(input);
  allowOnly(args, []);
  return {};
};

export const toolRegistry = {
  get_balance: {
    description: 'Get the authenticated user’s current account balance.',
    parameters: { type: 'object', properties: {} },
    validate: emptySchema,
    run: () => bank.getBalance()
  },
  get_transactions: {
    description: 'Get the latest transactions. Use limit to control how many are returned.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Number of transactions to return.' }
      }
    },
    validate(input) {
      const args = objectArgs(input);
      allowOnly(args, ['limit']);
      validateLimit(args.limit);
      return args;
    },
    run: (args) => bank.getTransactions(args)
  },
  search_transactions: {
    description: 'Search transactions by text, category, type, and optional date range.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Merchant, description, or keyword.' },
        category: { type: 'string', enum: categories, description: 'Transaction category.' },
        type: { type: 'string', enum: ['debit', 'credit'], description: 'Transaction type.' },
        startDate: { type: 'string', description: 'Start date in YYYY-MM-DD format.' },
        endDate: { type: 'string', description: 'End date in YYYY-MM-DD format.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Max number of transactions.' }
      }
    },
    validate(input) {
      const args = objectArgs(input);
      allowOnly(args, ['query', 'category', 'type', 'startDate', 'endDate', 'limit']);
      if (args.query !== undefined && (typeof args.query !== 'string' || args.query.trim().length > 80)) throw new Error('query must be a string of at most 80 characters.');
      validateEnum(args.category, categories, 'category');
      validateEnum(args.type, ['debit', 'credit'], 'type');
      validateDate(args.startDate, 'startDate');
      validateDate(args.endDate, 'endDate');
      validateLimit(args.limit);
      if (args.startDate && args.endDate && args.startDate > args.endDate) throw new Error('startDate must be on or before endDate.');
      return args;
    },
    run: (args) => bank.searchTransactions(args)
  },
  get_spending_summary: {
    description: 'Calculate debit spending for a time period, optionally limited to one category.',
    parameters: {
      type: 'object',
      properties: {
        period: { type: 'string', enum: periods, description: 'Time period to summarize.' },
        category: { type: 'string', enum: spendingCategories, description: 'Spending category to summarize.' }
      }
    },
    validate(input) {
      const args = objectArgs(input);
      allowOnly(args, ['period', 'category']);
      validateEnum(args.period, periods, 'period');
      validateEnum(args.category, spendingCategories, 'category');
      return args;
    },
    run: (args) => bank.getSpendingSummary(args)
  },
  transfer_money: {
    description: 'Request a money transfer. This only creates a pending confirmation; it never transfers funds. The user must confirm in the UI before execution.',
    parameters: {
      type: 'object',
      properties: {
        amount: { type: 'number', minimum: 1, maximum: 100000, description: 'Amount in INR to transfer.' },
        recipient: { type: 'string', description: 'Name of the saved beneficiary.' }
      },
      required: ['amount', 'recipient']
    },
    sensitive: true,
    validate(input) {
      const args = objectArgs(input);
      allowOnly(args, ['amount', 'recipient']);
      if (typeof args.amount !== 'number' || !Number.isFinite(args.amount) || args.amount <= 0 || args.amount > 100000 || Math.abs(args.amount * 100 - Math.round(args.amount * 100)) > 1e-7) {
        throw new Error('amount must be a positive INR amount up to ₹100,000 with at most two decimal places.');
      }
      if (typeof args.recipient !== 'string' || args.recipient.trim().length < 2 || args.recipient.trim().length > 60) throw new Error('recipient must be a name between 2 and 60 characters.');
      return { amount: args.amount, recipient: args.recipient.trim() };
    },
    prepare: (args) => bank.prepareTransfer(args)
  },
  block_card: {
    description: 'Request to block the user’s debit card. This only creates a pending confirmation; it never blocks the card until the user confirms in the UI.',
    parameters: { type: 'object', properties: {} },
    sensitive: true,
    validate: emptySchema,
    prepare: () => bank.prepareBlockCard()
  }
};

export function getGeminiTools() {
  return Object.entries(toolRegistry).map(([name, tool]) => ({
    name,
    description: tool.description,
    parameters: tool.parameters
  }));
}

export function validateAndRunTool(name, rawArgs) {
  const tool = toolRegistry[name];
  if (!tool) throw new Error(`Tool not allowed: ${name}`);
  let parsed;
  try {
    parsed = tool.validate(rawArgs ?? {});
  } catch (error) {
    throw new Error(`Invalid ${name} arguments: ${error.message}`);
  }
  if (tool.sensitive) return { kind: 'pending', action: tool.prepare(parsed) };
  return { kind: 'result', data: tool.run(parsed) };
}
