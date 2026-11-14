/**
 * @file backend/test/tools.test.js
 * @description Unit and integration test suite using Node.js built-in test runner (`node --test`).
 * Validates tool registry execution, input bounds and schema enforcement, pending action lifecycle,
 * balance mutations, two-phase card blocking, replay attack rejection, and deterministic demo agent intent routing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { resetMockState, getBalance, getCardStatus } from '../src/services/bankingService.js';
import { validateAndRunTool } from '../src/tools/bankingTools.js';

test.beforeEach(() => resetMockState());

test('get_balance returns the mock authenticated account balance', () => {
  const result = validateAndRunTool('get_balance', {});
  assert.equal(result.kind, 'result');
  assert.equal(result.data.balance, 58250.75);
});

test('get_transactions respects a validated limit', () => {
  const result = validateAndRunTool('get_transactions', { limit: 5 });
  assert.equal(result.data.length, 5);
});

test('food spending summary calculates this month only', () => {
  const result = validateAndRunTool('get_spending_summary', { period: 'this_month', category: 'food' });
  assert.equal(result.data.total, 1450);
  assert.equal(result.data.transactionCount, 3);
});

test('transfer tool prepares a pending action without changing balance', () => {
  const before = getBalance().balance;
  const result = validateAndRunTool('transfer_money', { amount: 5000, recipient: 'Rahul' });
  assert.equal(result.kind, 'pending');
  assert.equal(result.action.type, 'transfer');
  assert.equal(getBalance().balance, before);
});

test('invalid beneficiary and invalid tool arguments are rejected', () => {
  assert.throws(() => validateAndRunTool('transfer_money', { amount: 5000, recipient: 'Unknown' }), /saved beneficiaries/);
  assert.throws(() => validateAndRunTool('get_transactions', { limit: 1000 }), /Invalid get_transactions arguments/);
  assert.throws(() => validateAndRunTool('dangerous_tool', {}), /Tool not allowed/);
});

test('card block tool prepares only; card remains active until service execution', () => {
  const result = validateAndRunTool('block_card', {});
  assert.equal(result.kind, 'pending');
  assert.equal(result.action.type, 'block_card');
  assert.equal(getCardStatus().blocked, false);
});

test('confirmed transfer mutates the mock balance and adds a transaction', async () => {
  const { prepareTransfer, executeTransfer, getTransactions } = await import('../src/services/bankingService.js');
  const action = prepareTransfer({ amount: 5000, recipient: 'Rahul' });
  assert.equal(getBalance().balance, 58250.75);
  const result = executeTransfer(action);
  assert.equal(result.balance.balance, 53250.75);
  assert.equal(getTransactions({ limit: 1 })[0].description, 'Transfer to Rahul');
});

test('confirmed card block changes card state only when execute is called', async () => {
  const { prepareBlockCard, executeBlockCard } = await import('../src/services/bankingService.js');
  const action = prepareBlockCard();
  assert.equal(getCardStatus().blocked, false);
  const result = executeBlockCard(action);
  assert.equal(result.blocked, true);
  assert.equal(getCardStatus().blocked, true);
});

test('confirmation service executes a transfer only after explicit approval and rejects replay', async () => {
  const { createPendingActions, resolvePendingAction } = await import('../src/services/confirmationService.js');
  const { action } = validateAndRunTool('transfer_money', { amount: 5000, recipient: 'Rahul' });
  const [pending] = createPendingActions([action], 'mock-user-001');
  assert.equal(getBalance().balance, 58250.75);
  const result = resolvePendingAction({ confirmationId: pending.confirmationId, approved: true, userId: 'mock-user-001' });
  assert.equal(result.status, 'completed');
  assert.equal(result.result.balance.balance, 53250.75);
  assert.throws(() => resolvePendingAction({ confirmationId: pending.confirmationId, approved: true, userId: 'mock-user-001' }), /expired or is no longer available/);
});

test('cancelling a pending card block leaves the card active', async () => {
  const { createPendingActions, resolvePendingAction } = await import('../src/services/confirmationService.js');
  const { action } = validateAndRunTool('block_card', {});
  const [pending] = createPendingActions([action], 'mock-user-001');
  const result = resolvePendingAction({ confirmationId: pending.confirmationId, approved: false, userId: 'mock-user-001' });
  assert.equal(result.status, 'cancelled');
  assert.equal(getCardStatus().blocked, false);
});

test('demo agent handles all read-only assessment prompts and prepares sensitive actions', async () => {
  const { runDemoAgent } = await import('../src/llm/demoAgent.js');
  const balance = runDemoAgent("What's my balance?");
  assert.match(balance.text, /58,250\.75/);
  const txns = runDemoAgent('Show my last 5 transactions');
  assert.equal((txns.text.match(/\n• /g) || []).length, 5);
  const spending = runDemoAgent('How much did I spend on food this month?');
  assert.match(spending.text, /1,450\.00/);
  const transfer = runDemoAgent('Transfer ₹5000 to Rahul');
  assert.equal(transfer.pending[0].type, 'transfer');
  const block = runDemoAgent('Block my card');
  assert.equal(block.pending[0].type, 'block_card');
});
