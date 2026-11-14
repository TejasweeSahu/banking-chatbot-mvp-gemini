import test from 'node:test';
import assert from 'node:assert/strict';
import { balanceOf, freshDb, userCtx } from '../helpers.js';
import { prepareTransfer, LIMITS } from '../../src/services/transferService.js';
import { cancelAction, confirmAction, createPendingAction, getAction } from '../../src/services/actionService.js';
import { prepareBillPayment } from '../../src/services/billService.js';
import { prepareCardBlock, prepareCardUnblock } from '../../src/services/cardService.js';
import { createComplaint, escalateComplaint } from '../../src/services/supportService.js';
import { prepareAddBeneficiary } from '../../src/services/beneficiaryService.js';
import { availablePaise, getAccountRow } from '../../src/services/accountService.js';

const T = 'usr_tejas';
const SAV = 'acc_tejas_sav';

function prepareAndStore(db, user, input) {
  const r = prepareTransfer(db, user.id, input);
  assert.equal(r.status, 'ready', JSON.stringify(r));
  return createPendingAction(db, user, { type: 'transfer', payload: r.payload, preview: r.preview });
}

test('missing transfer parameters are reported, not guessed', () => {
  const db = freshDb();
  assert.deepEqual(prepareTransfer(db, T, { recipient: 'Priya' }).missing, ['amount']);
  assert.deepEqual(prepareTransfer(db, T, { amountPaise: 200000 }).missing, ['recipient']);
  assert.deepEqual(prepareTransfer(db, T, {}).missing, ['recipient', 'amount']);
});

test('ambiguous beneficiary returns clarification options instead of picking one', () => {
  const db = freshDb();
  const r = prepareTransfer(db, T, { recipient: 'Rahul', amountPaise: 200000 });
  assert.equal(r.status, 'needs_clarification');
  assert.equal(r.field, 'recipient');
  assert.equal(r.options.length, 2);
});

test('unknown beneficiary is rejected (transfers only to saved payees)', () => {
  const db = freshDb();
  const r = prepareTransfer(db, T, { recipient: 'Elon', amountPaise: 100 });
  assert.equal(r.status, 'rejected');
  assert.equal(r.code, 'beneficiary_not_found');
});

test('insufficient available balance is rejected, counting pending holds', () => {
  const db = freshDb();
  const available = availablePaise(db, getAccountRow(db, T, SAV));
  const r = prepareTransfer(db, T, { recipient: 'Priya', amountPaise: available + 100, method: 'neft' });
  assert.equal(r.status, 'rejected');
  assert.equal(r.code, 'insufficient_funds');
  // Exactly the available amount is allowed (holds are respected, not the raw ledger balance).
  assert.equal(prepareTransfer(db, T, { recipient: 'Priya', amountPaise: Math.min(available, LIMITS.dailyExternalPaise), method: 'neft' }).status, 'ready');
});

test('method and limit rules are enforced', () => {
  const db = freshDb();
  assert.equal(prepareTransfer(db, T, { recipient: 'Rahul Verma', amountPaise: 100000, method: 'upi' }).code, 'upi_unavailable');
  assert.equal(prepareTransfer(db, T, { recipient: 'Priya', amountPaise: 100000, method: 'rtgs' }).code, 'below_method_minimum');
  assert.equal(prepareTransfer(db, T, { recipient: 'Priya', amountPaise: 15_000_000, method: 'upi' }).code, 'above_method_limit');
  assert.equal(prepareTransfer(db, T, { recipient: 'Priya', amountPaise: 1000, fromAccount: 'fixed deposit' }).code, 'fd_not_transferable');
  assert.equal(prepareTransfer(db, T, { recipient: 'Priya', amountPaise: 50 }).code, 'invalid_amount');
  // Default method: UPI when the payee has a UPI ID, else IMPS.
  assert.equal(prepareTransfer(db, T, { recipient: 'Priya', amountPaise: 200000 }).payload.method, 'upi');
  assert.equal(prepareTransfer(db, T, { recipient: 'Rahul Verma', amountPaise: 200000 }).payload.method, 'imps');
});

test('preparing a transfer never moves money', () => {
  const db = freshDb();
  const before = balanceOf(db, SAV);
  prepareAndStore(db, userCtx(db), { recipient: 'Priya', amountPaise: 200000 });
  assert.equal(balanceOf(db, SAV), before);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM transfers').n, 0);
});

test('confirmation executes exactly once; replays return the same receipt', () => {
  const db = freshDb();
  const user = userCtx(db);
  const before = balanceOf(db, SAV);
  const action = prepareAndStore(db, user, { recipient: 'Priya', amountPaise: 200000 });
  const first = confirmAction(db, user, action.id);
  assert.equal(first.status, 'completed');
  assert.equal(first.replayed, false);
  assert.match(first.result.reference, /^NST\d{8}[A-Z0-9]{6}$/);
  assert.equal(balanceOf(db, SAV), before - 200000);
  const again = confirmAction(db, user, action.id);
  assert.equal(again.replayed, true);
  assert.equal(again.result.reference, first.result.reference);
  assert.equal(balanceOf(db, SAV), before - 200000, 'no double debit');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM transfers WHERE action_id = :id', { id: action.id }).n, 1);
  const txn = db.get('SELECT * FROM transactions WHERE reference = :r', { r: first.result.reference });
  assert.equal(txn.amount_paise, 200000);
  assert.equal(txn.direction, 'debit');
  assert.ok(db.get(`SELECT 1 AS x FROM audit_logs WHERE event = 'transfer.executed'`));
});

test('preparing the same transfer twice reuses one pending request', () => {
  const db = freshDb();
  const user = userCtx(db);
  const a = prepareAndStore(db, user, { recipient: 'Priya', amountPaise: 200000 });
  const b = prepareAndStore(db, user, { recipient: 'Priya', amountPaise: 200000 });
  assert.equal(a.id, b.id);
  assert.equal(b.reused, true);
  confirmAction(db, user, a.id);
  // After completion, a new identical request is allowed but carries a duplicate warning.
  const c = prepareTransfer(db, user.id, { recipient: 'Priya', amountPaise: 200000 });
  assert.ok(c.preview.warnings.some((w) => w.code === 'possible_duplicate'));
});

test('the database rejects a second transfer for the same action id', () => {
  const db = freshDb();
  const user = userCtx(db);
  const action = prepareAndStore(db, user, { recipient: 'Priya', amountPaise: 1000 });
  confirmAction(db, user, action.id);
  assert.throws(() => db.run(`INSERT INTO transfers (id, user_id, action_id, from_account_id, beneficiary_id, amount_paise, method, status, reference, created_at)
                               VALUES ('trf_x', 'usr_tejas', :a, 'acc_tejas_sav', 'ben_priya', 1000, 'upi', 'completed', 'REFX', 'now')`, { a: action.id }), /UNIQUE/);
});

test('cancelled and expired requests cannot be confirmed', () => {
  const db = freshDb();
  const user = userCtx(db);
  const before = balanceOf(db, SAV);
  const a = prepareAndStore(db, user, { recipient: 'Priya', amountPaise: 1000 });
  cancelAction(db, user, a.id);
  assert.throws(() => confirmAction(db, user, a.id), /cancelled/);
  const b = prepareAndStore(db, user, { recipient: 'Mom', amountPaise: 1000 });
  db.run(`UPDATE pending_actions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = :id`, { id: b.id });
  assert.throws(() => confirmAction(db, user, b.id), /expired/);
  assert.equal(getAction(db, user.id, b.id).status, 'expired');
  assert.equal(balanceOf(db, SAV), before);
});

test('another customer cannot see or confirm my request', () => {
  const db = freshDb();
  const me = userCtx(db);
  const aisha = userCtx(db, 'usr_aisha');
  const a = prepareAndStore(db, me, { recipient: 'Priya', amountPaise: 1000 });
  assert.throws(() => getAction(db, aisha.id, a.id), /not found/);
  assert.throws(() => confirmAction(db, aisha, a.id), /not found/);
  assert.equal(getAction(db, me.id, a.id).status, 'pending');
  assert.ok(db.get(`SELECT 1 AS x FROM audit_logs WHERE event = 'action.confirm' AND outcome = 'denied' AND user_id = 'usr_aisha'`));
});

test('read-only users cannot create or confirm money movement', () => {
  const db = freshDb();
  const meera = userCtx(db, 'usr_meera');
  const r = prepareTransfer(db, meera.id, { toAccount: 'savings', amountPaise: 100 });
  assert.throws(() => createPendingAction(db, meera, { type: 'transfer', payload: r.payload ?? {}, preview: {} }), /read-only/);
});

test('if the balance drops between preview and confirm, execution fails atomically', () => {
  const db = freshDb();
  const user = userCtx(db);
  const a = prepareAndStore(db, user, { recipient: 'Priya', amountPaise: 1_000_000 });
  db.run(`UPDATE accounts SET balance_paise = 500000 WHERE id = :id`, { id: SAV });
  assert.throws(() => confirmAction(db, user, a.id), /Insufficient/);
  assert.equal(balanceOf(db, SAV), 500000, 'nothing debited');
  assert.equal(getAction(db, user.id, a.id).status, 'failed');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM transfers').n, 0);
});

test('own-account transfer debits one account and credits the other', () => {
  const db = freshDb();
  const user = userCtx(db);
  const fromBefore = balanceOf(db, SAV);
  const toBefore = balanceOf(db, 'acc_tejas_fam');
  const r = prepareTransfer(db, T, { toAccount: 'family savings', amountPaise: 250000 });
  assert.equal(r.payload.method, 'internal');
  const action = createPendingAction(db, user, { type: 'transfer', payload: r.payload, preview: r.preview });
  confirmAction(db, user, action.id);
  assert.equal(balanceOf(db, SAV), fromBefore - 250000);
  assert.equal(balanceOf(db, 'acc_tejas_fam'), toBefore + 250000);
  assert.equal(prepareTransfer(db, T, { toAccount: 'fixed deposit', amountPaise: 100 }).code, 'destination_not_transactable');
});

test('daily external transfer limit counts completed transfers', () => {
  const db = freshDb();
  const user = userCtx(db);
  const a = prepareAndStore(db, user, { recipient: 'Priya', amountPaise: 15_000_000, method: 'neft' });
  confirmAction(db, user, a.id);
  const r = prepareTransfer(db, T, { recipient: 'Mom', amountPaise: 6_000_000, method: 'neft' });
  assert.equal(r.code, 'daily_limit');
});

test('bill payment: pay once, then the bill is no longer due', () => {
  const db = freshDb();
  const user = userCtx(db);
  const before = balanceOf(db, SAV);
  assert.equal(prepareBillPayment(db, T, {}).status, 'needs_clarification');
  const r = prepareBillPayment(db, T, { bill: 'electricity' });
  assert.equal(r.status, 'ready');
  const action = createPendingAction(db, user, { type: 'bill_payment', payload: r.payload, preview: r.preview });
  confirmAction(db, user, action.id);
  assert.equal(balanceOf(db, SAV), before - 138400);
  assert.equal(db.get(`SELECT status FROM bills WHERE id = 'bil_tpcodl_cur'`).status, 'paid');
  assert.equal(prepareBillPayment(db, T, { bill: 'electricity' }).code, 'bill_not_found');
});

test('card block/unblock lifecycle; permanent blocks cannot be undone', () => {
  const db = freshDb();
  const user = userCtx(db);
  assert.equal(prepareCardBlock(db, T, {}).status, 'needs_clarification', 'two cards → ask which');
  const temp = prepareCardBlock(db, T, { card: '7812' });
  assert.equal(temp.preview.permanent, false);
  confirmAction(db, user, createPendingAction(db, user, { type: 'card_block', payload: temp.payload, preview: temp.preview }).id);
  assert.equal(db.get(`SELECT status FROM cards WHERE id = 'crd_tejas_debit'`).status, 'temporarily_blocked');
  const un = prepareCardUnblock(db, T, {});
  assert.equal(un.status, 'ready');
  confirmAction(db, user, createPendingAction(db, user, { type: 'card_unblock', payload: un.payload, preview: un.preview }).id);
  assert.equal(db.get(`SELECT status FROM cards WHERE id = 'crd_tejas_debit'`).status, 'active');
  const lost = prepareCardBlock(db, T, { card: '7812', reason: 'lost' });
  confirmAction(db, user, createPendingAction(db, user, { type: 'card_block', payload: lost.payload, preview: lost.preview }).id);
  assert.equal(prepareCardUnblock(db, T, { card: '7812' }).code, 'permanently_blocked');
});

test('complaints: create, dedupe per transaction, escalate; foreign transactions rejected', () => {
  const db = freshDb();
  const dup = db.get(`SELECT id FROM transactions WHERE merchant = 'Swiggy' AND amount_paise = 48600 ORDER BY posted_at DESC LIMIT 1`).id;
  const c = createComplaint(db, T, { category: 'duplicate_charge', transactionId: dup, description: 'Charged twice for one Swiggy order' });
  assert.match(c.reference, /^CMP-\d{6}$/);
  assert.equal(c.status, 'open');
  assert.equal(c.slaDueDate, '2026-11-21');
  const again = createComplaint(db, T, { category: 'duplicate_charge', transactionId: dup, description: 'Charged twice for one Swiggy order' });
  assert.equal(again.reference, c.reference);
  assert.equal(again.alreadyExisted, true);
  const e = escalateComplaint(db, T, { reference: c.reference });
  assert.equal(e.status, 'escalated');
  assert.equal(e.priority, 'high');
  const aishaTxn = db.get(`SELECT id FROM transactions WHERE user_id = 'usr_aisha' LIMIT 1`).id;
  assert.throws(() => createComplaint(db, T, { category: 'dispute', transactionId: aishaTxn, description: 'Not my transaction at all' }), /could not find/);
  assert.throws(() => createComplaint(db, T, { category: 'other', description: 'short' }), /more detail/);
});

test('add-beneficiary validation', () => {
  const db = freshDb();
  const base = { name: 'Kiran Rao', accountNumber: '123456789012', confirmAccountNumber: '123456789012', ifsc: 'HDFC0001234' };
  assert.equal(prepareAddBeneficiary(db, T, base).status, 'ready');
  assert.equal(prepareAddBeneficiary(db, T, base).preview.bankName, 'HDFC Bank');
  assert.throws(() => prepareAddBeneficiary(db, T, { ...base, ifsc: 'HDFC1234' }), /IFSC/);
  assert.throws(() => prepareAddBeneficiary(db, T, { ...base, confirmAccountNumber: '1' }), /do not match/);
  assert.throws(() => prepareAddBeneficiary(db, T, { ...base, name: '<script>' }), /letters/);
  assert.equal(prepareAddBeneficiary(db, T, { ...base, accountNumber: '50100234814821', confirmAccountNumber: '50100234814821', ifsc: 'HDFC0001234' }).code, 'duplicate_beneficiary');
  assert.equal(prepareAddBeneficiary(db, T, { ...base, accountNumber: '30881209375531', confirmAccountNumber: '30881209375531' }).code, 'own_account');
});
