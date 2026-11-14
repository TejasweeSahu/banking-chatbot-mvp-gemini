/**
 * Fund transfers (simulated). Two phases:
 *  prepareTransfer  — resolves recipient, validates amount/method/limits/balance
 *                     and returns a preview. Never mutates state.
 *  executeTransfer  — re-validates against fresh data and posts the debit (and
 *                     credit, for own-account transfers) atomically. Only called
 *                     by the action service after explicit user confirmation.
 */

import { money } from '../lib/money.js';
import { nowIso, today } from '../lib/dates.js';
import { unprocessable } from '../lib/errors.js';
import { availablePaise, getAccountRow, isTransactable, resolveAccount } from './accountService.js';
import { formatBeneficiary, getBeneficiaryRow, resolveBeneficiary } from './beneficiaryService.js';
import { cleanText, maskNumber, newId, newReference } from './common.js';
import { audit } from './auditService.js';

const RUPEE = 100;
export const LIMITS = {
  minPaise: 1 * RUPEE,
  dailyExternalPaise: 200_000 * RUPEE,
  methods: {
    upi: { label: 'UPI', maxPaise: 100_000 * RUPEE, eta: 'Instant' },
    imps: { label: 'IMPS', maxPaise: 500_000 * RUPEE, eta: 'Instant' },
    neft: { label: 'NEFT', maxPaise: 1_000_000 * RUPEE, eta: 'Usually within 30 minutes' },
    rtgs: { label: 'RTGS', minPaise: 200_000 * RUPEE, maxPaise: 1_000_000 * RUPEE, eta: 'Usually within 30 minutes' },
    internal: { label: 'Own-account transfer', maxPaise: 1_000_000 * RUPEE, eta: 'Instant' }
  }
};

const fail = (code, message) => ({ status: 'rejected', code, message });

function sentTodayPaise(db, userId) {
  const row = db.get(`SELECT COALESCE(SUM(amount_paise), 0) AS s FROM transfers WHERE user_id = :userId AND status = 'completed'
                      AND beneficiary_id IS NOT NULL AND substr(created_at, 1, 10) = :day`, { userId, day: today() });
  return row.s;
}

function chooseMethod({ toOwn, beneficiary, amountPaise }) {
  if (toOwn) return 'internal';
  if (beneficiary?.vpa && amountPaise <= LIMITS.methods.upi.maxPaise) return 'upi';
  if (amountPaise <= LIMITS.methods.imps.maxPaise) return 'imps';
  return 'neft';
}

/**
 * input: { recipient?, toAccount?, amountPaise?, method?, fromAccount?, note? }
 * Returns one of: ready | needs_input | needs_clarification | rejected.
 */
export function prepareTransfer(db, userId, input) {
  const missing = [];
  if (!input.recipient && !input.toAccount) missing.push('recipient');
  if (input.amountPaise == null) missing.push('amount');
  if (missing.length) {
    return { status: 'needs_input', missing, message: missing.length === 2 ? 'Who would you like to pay, and how much?' : missing[0] === 'amount' ? 'How much would you like to send?' : 'Who would you like to send money to?' };
  }
  if (!Number.isSafeInteger(input.amountPaise) || input.amountPaise < LIMITS.minPaise) return fail('invalid_amount', 'The amount must be at least ₹1.00.');

  // Source account.
  const from = resolveAccount(db, userId, input.fromAccount, { transactableOnly: true });
  if (from.status === 'ambiguous') {
    return { status: 'needs_clarification', field: 'fromAccount', message: 'Which account should the money come from?', options: from.candidates.map((a) => ({ label: `${a.nickname} ${maskNumber(a.account_number)}`, value: a.id })) };
  }
  if (from.status === 'not_found') {
    const fd = input.fromAccount && resolveAccount(db, userId, input.fromAccount);
    if (fd?.status === 'resolved' && fd.account.type === 'fixed_deposit') return fail('fd_not_transferable', 'Transfers cannot be made from a fixed deposit. Please choose a savings account.');
    return fail('source_not_found', 'I could not find that source account.');
  }
  const source = from.account;

  // Destination: own account or saved beneficiary.
  let beneficiary = null;
  let toOwnAccount = null;
  if (input.toAccount) {
    const to = resolveAccount(db, userId, input.toAccount);
    if (to.status === 'ambiguous') return { status: 'needs_clarification', field: 'toAccount', message: 'Which of your accounts should receive the money?', options: to.candidates.filter((a) => a.id !== source.id).map((a) => ({ label: `${a.nickname} ${maskNumber(a.account_number)}`, value: a.id })) };
    if (to.status !== 'resolved') return fail('destination_not_found', 'I could not find that account among your accounts.');
    if (to.account.id === source.id) return fail('same_account', 'The source and destination accounts are the same.');
    if (!isTransactable(to.account)) return fail('destination_not_transactable', 'Money cannot be moved into a fixed deposit through a transfer. You can open a new deposit instead.');
    toOwnAccount = to.account;
  } else {
    const match = resolveBeneficiary(db, userId, input.recipient);
    if (match.status === 'ambiguous') {
      return { status: 'needs_clarification', field: 'recipient', message: `You have ${match.candidates.length} saved beneficiaries matching "${cleanText(input.recipient, 40)}". Which one did you mean?`, options: match.candidates.map((b) => ({ label: formatBeneficiary(b).label, value: b.id })) };
    }
    if (match.status === 'not_found') {
      return { status: 'rejected', code: 'beneficiary_not_found', message: `"${cleanText(input.recipient, 40)}" is not one of your saved beneficiaries. For security, transfers can only go to saved beneficiaries. You can add a new beneficiary first.`, suggestions: match.suggestions.map((b) => b.label) };
    }
    beneficiary = match.beneficiary;
  }

  // Method and limits.
  const method = input.method ?? chooseMethod({ toOwn: Boolean(toOwnAccount), beneficiary, amountPaise: input.amountPaise });
  if (toOwnAccount && method !== 'internal') return fail('invalid_method', 'Transfers between your own accounts are made internally.');
  if (!toOwnAccount && method === 'internal') return fail('invalid_method', 'Choose UPI, IMPS, NEFT or RTGS for payments to beneficiaries.');
  const rule = LIMITS.methods[method];
  if (method === 'upi' && !beneficiary.vpa) return fail('upi_unavailable', `${beneficiary.name} has no UPI ID saved. Use IMPS or NEFT instead.`);
  if (rule.minPaise && input.amountPaise < rule.minPaise) return fail('below_method_minimum', `${rule.label} is only for amounts of ${money(rule.minPaise).formatted} or more.`);
  if (input.amountPaise > rule.maxPaise) return fail('above_method_limit', `${rule.label} transfers are limited to ${money(rule.maxPaise).formatted} per transaction.`);
  if (!toOwnAccount) {
    const sent = sentTodayPaise(db, userId);
    if (sent + input.amountPaise > LIMITS.dailyExternalPaise) {
      return fail('daily_limit', `This would exceed your daily transfer limit of ${money(LIMITS.dailyExternalPaise).formatted}. You can still send ${money(Math.max(0, LIMITS.dailyExternalPaise - sent)).formatted} today.`);
    }
  }
  const available = availablePaise(db, source);
  if (input.amountPaise > available) {
    return { status: 'rejected', code: 'insufficient_funds', message: `Insufficient available balance. ${source.nickname} ${maskNumber(source.account_number)} has ${money(available).formatted} available.`, available: money(available) };
  }

  const note = input.note ? cleanText(input.note, 60) : null;
  const warnings = [];
  const recent = db.get(`SELECT reference, created_at FROM transfers WHERE user_id = :userId AND status = 'completed' AND amount_paise = :amount
                         AND ${beneficiary ? 'beneficiary_id = :dest' : 'to_account_id = :dest'} AND created_at >= :since ORDER BY created_at DESC LIMIT 1`,
  { userId, amount: input.amountPaise, dest: beneficiary?.id ?? toOwnAccount.id, since: new Date(Date.now() - 24 * 3600_000).toISOString() });
  if (recent) warnings.push({ code: 'possible_duplicate', message: `You already sent this exact amount to this recipient recently (ref ${recent.reference}). Make sure this is not a duplicate.` });
  if (input.amountPaise >= available * 0.8) warnings.push({ code: 'large_share_of_balance', message: 'This transfer uses most of your available balance.' });

  const payload = { fromAccountId: source.id, beneficiaryId: beneficiary?.id ?? null, toAccountId: toOwnAccount?.id ?? null, amountPaise: input.amountPaise, method, note };
  const preview = {
    amount: money(input.amountPaise),
    fee: money(0),
    method,
    methodLabel: rule.label,
    eta: rule.eta,
    from: { id: source.id, nickname: source.nickname, maskedNumber: maskNumber(source.account_number), availableBefore: money(available), availableAfter: money(available - input.amountPaise), defaulted: from.defaulted },
    to: beneficiary
      ? { kind: 'beneficiary', id: beneficiary.id, name: beneficiary.name, nickname: beneficiary.nickname, bankName: beneficiary.bank_name, maskedAccount: maskNumber(beneficiary.account_number), ifsc: beneficiary.ifsc }
      : { kind: 'own_account', id: toOwnAccount.id, name: toOwnAccount.nickname, bankName: 'Northstar Bank', maskedAccount: maskNumber(toOwnAccount.account_number) },
    note,
    warnings,
    simulated: true
  };
  return { status: 'ready', payload, preview };
}

/** Executes inside the caller's DB transaction. Throws on any business-rule failure. */
export function executeTransfer(db, userId, payload, actionId) {
  const source = getAccountRow(db, userId, payload.fromAccountId);
  if (!isTransactable(source)) throw unprocessable('The source account can no longer make transfers.', 'source_unavailable');
  const beneficiary = payload.beneficiaryId ? getBeneficiaryRow(db, userId, payload.beneficiaryId) : null;
  const dest = payload.toAccountId ? getAccountRow(db, userId, payload.toAccountId) : null;
  if (dest && !isTransactable(dest)) throw unprocessable('The destination account cannot receive transfers.', 'destination_unavailable');
  if (beneficiary && sentTodayPaise(db, userId) + payload.amountPaise > LIMITS.dailyExternalPaise) throw unprocessable('This transfer would exceed your daily transfer limit.', 'daily_limit');
  const available = availablePaise(db, source);
  if (payload.amountPaise > available) throw unprocessable(`Insufficient available balance. Your available balance is now ${money(available).formatted}.`, 'insufficient_funds');

  const now = nowIso();
  const date = now.slice(0, 10);
  const transferId = newId('trf');
  const reference = newReference('NST', date);
  const debitId = newId('txn');
  const channel = payload.method === 'internal' ? 'internal' : payload.method;
  const counterparty = beneficiary ? beneficiary.name : dest.nickname;

  // Guarded debit: the WHERE clause makes overdraft impossible even under a race.
  const debit = db.run('UPDATE accounts SET balance_paise = balance_paise - :amount WHERE id = :id AND balance_paise >= :amount', { amount: payload.amountPaise, id: source.id });
  if (debit.changes !== 1) throw unprocessable('Insufficient balance.', 'insufficient_funds');

  db.run(`INSERT INTO transfers (id, user_id, action_id, from_account_id, beneficiary_id, to_account_id, amount_paise, method, note, status, reference, debit_transaction_id, created_at)
          VALUES (:id, :userId, :actionId, :from, :ben, :to, :amount, :method, :note, 'completed', :reference, :debitId, :now)`,
  { id: transferId, userId, actionId, from: source.id, ben: beneficiary?.id ?? null, to: dest?.id ?? null, amount: payload.amountPaise, method: payload.method, note: payload.note, reference, debitId, now });
  db.run(`INSERT INTO transactions (id, user_id, account_id, date, posted_at, description, merchant, category_id, direction, amount_paise, status, channel, reference, transfer_id, created_at)
          VALUES (:id, :userId, :account, :date, :now, :description, :merchant, 'transfers', 'debit', :amount, 'success', :channel, :reference, :transferId, :now)`,
  { id: debitId, userId, account: source.id, date, now, description: `${LIMITS.methods[payload.method].label} to ${counterparty}${payload.note ? ` — ${payload.note}` : ''}`, merchant: counterparty, amount: payload.amountPaise, channel, reference, transferId });
  if (dest) {
    db.run('UPDATE accounts SET balance_paise = balance_paise + :amount WHERE id = :id', { amount: payload.amountPaise, id: dest.id });
    db.run(`INSERT INTO transactions (id, user_id, account_id, date, posted_at, description, merchant, category_id, direction, amount_paise, status, channel, reference, transfer_id, created_at)
            VALUES (:id, :userId, :account, :date, :now, :description, :merchant, 'transfers', 'credit', :amount, 'success', 'internal', :reference, :transferId, :now)`,
    { id: newId('txn'), userId, account: dest.id, date, now, description: `Transfer from ${source.nickname} ${maskNumber(source.account_number)}`, merchant: source.nickname, amount: payload.amountPaise, reference: `${reference}C`, transferId });
  }
  audit(db, { userId, event: 'transfer.executed', resourceType: 'transfer', resourceId: transferId, details: { reference, amountPaise: payload.amountPaise, method: payload.method, beneficiaryId: beneficiary?.id, toAccountId: dest?.id } });

  const updated = getAccountRow(db, userId, source.id);
  return {
    transferId,
    reference,
    status: 'completed',
    amount: money(payload.amountPaise),
    method: LIMITS.methods[payload.method].label,
    to: beneficiary ? { name: beneficiary.name, bankName: beneficiary.bank_name, maskedAccount: maskNumber(beneficiary.account_number) } : { name: dest.nickname, bankName: 'Northstar Bank', maskedAccount: maskNumber(dest.account_number) },
    from: { nickname: source.nickname, maskedNumber: maskNumber(source.account_number) },
    newAvailableBalance: money(availablePaise(db, updated)),
    executedAt: now,
    simulated: true,
    message: `${money(payload.amountPaise).formatted} sent to ${counterparty} via ${LIMITS.methods[payload.method].label}. Reference ${reference}.`
  };
}

export function listTransfers(db, userId, { limit = 20 } = {}) {
  const rows = db.all(`SELECT t.*, b.name AS ben_name, a.nickname AS to_nickname FROM transfers t LEFT JOIN beneficiaries b ON b.id = t.beneficiary_id
                       LEFT JOIN accounts a ON a.id = t.to_account_id WHERE t.user_id = :userId ORDER BY t.created_at DESC LIMIT :limit`, { userId, limit });
  return rows.map((t) => ({ id: t.id, reference: t.reference, amount: money(t.amount_paise), method: t.method, to: t.ben_name ?? t.to_nickname, status: t.status, createdAt: t.created_at }));
}

