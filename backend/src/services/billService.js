/**
 * Bill payments (simulated). Bills are resolved by id or biller name, previewed,
 * and paid only after confirmation through the action service.
 */

import { money } from '../lib/money.js';
import { daysBetween, nowIso, today } from '../lib/dates.js';
import { notFound, unprocessable } from '../lib/errors.js';
import { availablePaise, getAccountRow, isTransactable, resolveAccount } from './accountService.js';
import { maskNumber, newId, newReference } from './common.js';
import { audit } from './auditService.js';

function formatBill(b) {
  return {
    id: b.id,
    biller: b.biller_name,
    consumerNumber: maskNumber(b.consumer_number),
    period: b.period_label,
    amount: money(b.amount_paise),
    dueDate: b.due_date,
    daysUntilDue: daysBetween(today(), b.due_date),
    status: b.status
  };
}

const BILL_SELECT = `SELECT b.*, bl.name AS biller_name, bl.consumer_number FROM bills b JOIN billers bl ON bl.id = b.biller_id`;

export function listBills(db, userId, { status } = {}) {
  const rows = db.all(`${BILL_SELECT} WHERE b.user_id = :userId ${status ? 'AND b.status = :status' : ''} ORDER BY b.status, b.due_date`, status ? { userId, status } : { userId });
  return rows.map(formatBill);
}

export function prepareBillPayment(db, userId, { bill, fromAccount }) {
  const due = db.all(`${BILL_SELECT} WHERE b.user_id = :userId AND b.status = 'due' ORDER BY b.due_date`, { userId });
  if (!due.length) return { status: 'rejected', code: 'no_bills_due', message: 'You have no bills due right now.' };
  let matches = due;
  if (bill) {
    const q = String(bill).toLowerCase();
    matches = due.filter((b) => b.id === bill || b.biller_name.toLowerCase().includes(q) || q.split(/\s+/).some((t) => t.length >= 3 && b.biller_name.toLowerCase().includes(t)));
    if (!matches.length) return { status: 'rejected', code: 'bill_not_found', message: `I could not find a due bill matching "${String(bill).slice(0, 40)}".`, dueBills: due.map(formatBill) };
  }
  if (matches.length > 1) {
    return { status: 'needs_clarification', field: 'bill', message: 'Which bill would you like to pay?', options: matches.map((b) => ({ label: `${b.biller_name} — ${money(b.amount_paise).formatted}, due ${b.due_date}`, value: b.id })) };
  }
  const target = matches[0];
  const from = resolveAccount(db, userId, fromAccount, { transactableOnly: true });
  if (from.status === 'ambiguous') return { status: 'needs_clarification', field: 'fromAccount', message: 'Which account should I pay from?', options: from.candidates.map((a) => ({ label: `${a.nickname} ${maskNumber(a.account_number)}`, value: a.id })) };
  if (from.status !== 'resolved') return { status: 'rejected', code: 'source_not_found', message: 'I could not find that source account.' };
  const available = availablePaise(db, from.account);
  if (target.amount_paise > available) return { status: 'rejected', code: 'insufficient_funds', message: `Insufficient available balance (${money(available).formatted}).` };
  return {
    status: 'ready',
    payload: { billId: target.id, fromAccountId: from.account.id },
    preview: { bill: formatBill(target), amount: money(target.amount_paise), from: { nickname: from.account.nickname, maskedNumber: maskNumber(from.account.account_number), availableBefore: money(available), availableAfter: money(available - target.amount_paise) }, simulated: true }
  };
}

export function executeBillPayment(db, userId, payload) {
  const bill = db.get(`${BILL_SELECT} WHERE b.id = :id AND b.user_id = :userId`, { id: payload.billId, userId });
  if (!bill) throw notFound('Bill not found.');
  if (bill.status !== 'due') throw unprocessable('This bill has already been paid.', 'already_paid');
  const source = getAccountRow(db, userId, payload.fromAccountId);
  if (!isTransactable(source)) throw unprocessable('The source account cannot make payments.', 'source_unavailable');
  if (bill.amount_paise > availablePaise(db, source)) throw unprocessable('Insufficient available balance.', 'insufficient_funds');
  const now = nowIso();
  const txnId = newId('txn');
  const reference = newReference('BIL', now.slice(0, 10));
  const debit = db.run('UPDATE accounts SET balance_paise = balance_paise - :amount WHERE id = :id AND balance_paise >= :amount', { amount: bill.amount_paise, id: source.id });
  if (debit.changes !== 1) throw unprocessable('Insufficient balance.', 'insufficient_funds');
  const biller = db.get('SELECT category_id FROM billers WHERE id = :id', { id: bill.biller_id });
  db.run(`INSERT INTO transactions (id, user_id, account_id, date, posted_at, description, merchant, category_id, direction, amount_paise, status, channel, reference, created_at)
          VALUES (:id, :userId, :account, :date, :now, :description, :merchant, :category, 'debit', :amount, 'success', 'netbanking', :reference, :now)`,
  { id: txnId, userId, account: source.id, date: now.slice(0, 10), now, description: `${bill.biller_name} bill payment (${bill.period_label})`, merchant: bill.biller_name, category: biller.category_id, amount: bill.amount_paise, reference });
  db.run(`UPDATE bills SET status = 'paid', paid_transaction_id = :txnId WHERE id = :id AND status = 'due'`, { txnId, id: bill.id });
  audit(db, { userId, event: 'bill.paid', resourceType: 'bill', resourceId: bill.id, details: { reference, amountPaise: bill.amount_paise } });
  return { reference, status: 'completed', biller: bill.biller_name, amount: money(bill.amount_paise), newAvailableBalance: money(availablePaise(db, getAccountRow(db, userId, source.id))), simulated: true, message: `${bill.biller_name} bill of ${money(bill.amount_paise).formatted} paid. Reference ${reference}.` };
}
