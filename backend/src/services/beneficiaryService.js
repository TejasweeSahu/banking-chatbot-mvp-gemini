/**
 * Saved beneficiaries: listing, name resolution (with ambiguity detection) and
 * the add-beneficiary workflow (prepared, then executed only after confirmation).
 */

import { badRequest, conflict, notFound } from '../lib/errors.js';
import { cleanText, maskNumber, newId } from './common.js';
import { audit } from './auditService.js';

const BANKS_BY_IFSC = { HDFC: 'HDFC Bank', ICIC: 'ICICI Bank', SBIN: 'State Bank of India', UTIB: 'Axis Bank', KKBK: 'Kotak Mahindra Bank', NSTR: 'Northstar Bank', PUNB: 'Punjab National Bank', BARB: 'Bank of Baroda', CNRB: 'Canara Bank', YESB: 'Yes Bank', IDIB: 'Indian Bank' };
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const ACCOUNT_RE = /^\d{9,18}$/;
const VPA_RE = /^[a-z0-9._-]{2,64}@[a-z]{2,32}$/i;
const NAME_RE = /^[\p{L} .'-]{2,60}$/u;

export function formatBeneficiary(b) {
  return {
    id: b.id,
    name: b.name,
    nickname: b.nickname,
    bankName: b.bank_name,
    maskedAccount: maskNumber(b.account_number),
    ifsc: b.ifsc,
    upiEnabled: Boolean(b.vpa),
    maskedVpa: b.vpa ? `${b.vpa.slice(0, 2)}•••@${b.vpa.split('@')[1]}` : null,
    label: `${b.name}${b.nickname ? ` (${b.nickname})` : ''} — ${b.bank_name} ${maskNumber(b.account_number)}`
  };
}

export function listBeneficiaries(db, userId) {
  const rows = db.all(`SELECT * FROM beneficiaries WHERE user_id = :userId AND status = 'active' ORDER BY name`, { userId });
  return rows.map((b) => {
    const last = db.get(`SELECT t.created_at, t.amount_paise FROM transfers t WHERE t.user_id = :userId AND t.beneficiary_id = :id AND t.status = 'completed' ORDER BY t.created_at DESC LIMIT 1`, { userId, id: b.id });
    return { ...formatBeneficiary(b), lastPaidAt: last?.created_at ?? null };
  });
}

export function getBeneficiaryRow(db, userId, id) {
  const row = db.get(`SELECT * FROM beneficiaries WHERE id = :id AND user_id = :userId AND status = 'active'`, { id, userId });
  if (!row) throw notFound('Beneficiary not found.');
  return row;
}

const normalize = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
const STOP = new Set(['my', 'to', 'the', 'mr', 'mrs', 'ms', 'dr', 'account', 'acc', 'bank', 'a', 'c']);
const BANK_WORDS = new Set(['hdfc', 'icici', 'sbi', 'axis', 'kotak', 'northstar', 'canara', 'baroda', 'punjab']);
// Words from formatted bank names ("State Bank of India") that should not count as name tokens.
const BANK_FILLER = new Set(['state', 'of', 'india', 'mahindra', 'national']);

/**
 * Resolve free text ("Rahul", "mom", "Rahul Sharma HDFC 4821") to exactly one
 * active beneficiary. Returns resolved | ambiguous | not_found.
 */
export function resolveBeneficiary(db, userId, query) {
  const rows = db.all(`SELECT * FROM beneficiaries WHERE user_id = :userId AND status = 'active'`, { userId });
  if (rows.some((b) => b.id === query)) return { status: 'resolved', beneficiary: rows.find((b) => b.id === query) };
  const q = normalize(query);
  const tokens = q.split(' ').filter((t) => t && !STOP.has(t));
  const digits = tokens.filter((t) => /^\d{4}$/.test(t));
  const bankHints = tokens.filter((t) => BANK_WORDS.has(t));
  const nameish = tokens.filter((t) => !BANK_WORDS.has(t) && !/^\d+$/.test(t) && !BANK_FILLER.has(t));
  if (!nameish.length) return { status: 'not_found', suggestions: rows.map(formatBeneficiary) };

  const scored = rows.map((b) => {
    const name = normalize(b.name);
    const nick = normalize(b.nickname);
    const nameTokens = name.split(' ');
    const bankTokens = normalize(b.bank_name).split(' ');
    let score = 0;
    if (q === name || (nick && q === nick) || q.includes(name) || (nick && nameish.join(' ') === nick)) score = 3;
    else if (nameish.every((t) => nameTokens.includes(t))) score = 2;
    else if (nameish.every((t) => t.length >= 3 && nameTokens.some((n) => n.startsWith(t)))) score = 1;
    // Extra hints in the query (last 4 digits, bank name) must agree with the candidate.
    if (score && digits.length && !digits.some((d) => b.account_number.endsWith(d))) score = 0;
    if (score && bankHints.length && !bankHints.every((t) => bankTokens.includes(t) || (t === 'sbi' && b.bank_name === 'State Bank of India'))) score = 0;
    return { b, score };
  }).filter((s) => s.score > 0);

  if (!scored.length) return { status: 'not_found', suggestions: rows.map(formatBeneficiary) };
  const best = Math.max(...scored.map((s) => s.score));
  const top = scored.filter((s) => s.score === best).map((s) => s.b);
  if (top.length === 1) return { status: 'resolved', beneficiary: top[0] };
  return { status: 'ambiguous', candidates: top };
}

/** Validate and normalise add-beneficiary input. Returns ready | needs_input | rejected. */
export function prepareAddBeneficiary(db, userId, input) {
  const name = cleanText(input.name, 60);
  const accountNumber = String(input.accountNumber ?? '').replace(/\s/g, '');
  const confirmAccountNumber = input.confirmAccountNumber == null ? accountNumber : String(input.confirmAccountNumber).replace(/\s/g, '');
  const ifsc = String(input.ifsc ?? '').trim().toUpperCase();
  const vpa = input.vpa ? String(input.vpa).trim().toLowerCase() : null;
  const nickname = input.nickname ? cleanText(input.nickname, 30) : null;
  const missing = [];
  if (!name) missing.push('name');
  if (!accountNumber) missing.push('accountNumber');
  if (!ifsc) missing.push('ifsc');
  if (missing.length) return { status: 'needs_input', missing, message: `Please provide: ${missing.join(', ')}.` };
  if (!NAME_RE.test(name)) throw badRequest('Beneficiary name may only contain letters, spaces, dots, apostrophes and hyphens.');
  if (!ACCOUNT_RE.test(accountNumber)) throw badRequest('Account number must be 9 to 18 digits.');
  if (accountNumber !== confirmAccountNumber) throw badRequest('Account numbers do not match.');
  if (!IFSC_RE.test(ifsc)) throw badRequest('IFSC must look like HDFC0001234 (4 letters, 0, then 6 letters or digits).');
  if (vpa && !VPA_RE.test(vpa)) throw badRequest('UPI ID must look like name@bank.');
  if (nickname && !NAME_RE.test(nickname)) throw badRequest('Nickname contains unsupported characters.');
  const dup = db.get(`SELECT id, status FROM beneficiaries WHERE user_id = :userId AND account_number = :accountNumber AND ifsc = :ifsc`, { userId, accountNumber, ifsc });
  if (dup?.status === 'active') return { status: 'rejected', code: 'duplicate_beneficiary', message: 'This account is already one of your saved beneficiaries.' };
  const own = db.get('SELECT 1 AS x FROM accounts WHERE user_id = :userId AND account_number = :accountNumber', { userId, accountNumber });
  if (own) return { status: 'rejected', code: 'own_account', message: 'That is one of your own accounts. You can transfer to it directly without adding it.' };
  const bankName = BANKS_BY_IFSC[ifsc.slice(0, 4)] ?? `${ifsc.slice(0, 4)} Bank`;
  return {
    status: 'ready',
    payload: { name, nickname, accountNumber, ifsc, vpa, bankName },
    preview: { name, nickname, bankName, ifsc, maskedAccount: maskNumber(accountNumber), upiEnabled: Boolean(vpa), notice: 'For your safety, verify these details with the recipient before confirming.' }
  };
}

export function executeAddBeneficiary(db, userId, payload) {
  const dup = db.get(`SELECT id, status FROM beneficiaries WHERE user_id = :userId AND account_number = :accountNumber AND ifsc = :ifsc`, { userId, ...payload });
  if (dup?.status === 'active') throw conflict('This beneficiary already exists.');
  const id = dup?.id ?? newId('ben');
  if (dup) {
    db.run(`UPDATE beneficiaries SET status = 'active', name = :name, nickname = :nickname, vpa = :vpa, bank_name = :bankName WHERE id = :id`, { id, ...payload });
  } else {
    db.run(`INSERT INTO beneficiaries (id, user_id, name, nickname, bank_name, account_number, ifsc, vpa, created_at)
            VALUES (:id, :userId, :name, :nickname, :bankName, :accountNumber, :ifsc, :vpa, :now)`, { id, userId, ...payload, now: new Date().toISOString() });
  }
  audit(db, { userId, event: 'beneficiary.added', resourceType: 'beneficiary', resourceId: id, details: { bankName: payload.bankName, accountNumber: payload.accountNumber } });
  const row = getBeneficiaryRow(db, userId, id);
  return { beneficiary: formatBeneficiary(row), message: `${row.name} was added to your saved beneficiaries.` };
}
