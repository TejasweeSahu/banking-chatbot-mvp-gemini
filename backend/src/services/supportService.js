/**
 * Customer support: grounded help-article search, complaint registration,
 * tracking and escalation.
 */

import { addDays, daysBetween, today } from '../lib/dates.js';
import { badRequest, notFound } from '../lib/errors.js';
import { HELP_ARTICLES } from '../data/helpArticles.js';
import { cleanText, formatTransaction, newId } from './common.js';
import { findTransaction } from './transactionService.js';
import { accountsMap } from './accountService.js';
import { audit } from './auditService.js';
import { randomInt } from 'node:crypto';

export const COMPLAINT_CATEGORIES = {
  failed_upi: { label: 'Failed UPI transaction', slaDays: 5 },
  pending_payment: { label: 'Pending payment', slaDays: 3 },
  refund: { label: 'Refund not received', slaDays: 7 },
  duplicate_charge: { label: 'Duplicate charge', slaDays: 7 },
  card_issue: { label: 'Card issue', slaDays: 3 },
  dispute: { label: 'Transaction dispute', slaDays: 30 },
  other: { label: 'Other', slaDays: 7 }
};

export const ESCALATION_CONTACT = {
  helpline: '1800-000-0000 (simulated, 24×7)',
  email: 'grievance.officer@northstar.example',
  note: 'Escalated complaints are reviewed by a senior grievance officer within 3 working days. If unresolved after 30 days, you can approach the RBI Ombudsman.'
};

export function searchHelpArticles(query, limit = 3) {
  const words = String(query).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  const scored = HELP_ARTICLES.map((a) => {
    const hay = `${a.title} ${a.body}`.toLowerCase();
    let score = 0;
    for (const w of words) {
      if (a.tags.some((t) => t === w || t.startsWith(w))) score += 3;
      else if (hay.includes(w)) score += 1;
    }
    return { a, score };
  }).filter((s) => s.score > 0).sort((x, y) => y.score - x.score).slice(0, limit);
  return { query: cleanText(query, 120), articles: scored.map(({ a }) => ({ id: a.id, title: a.title, content: a.body })), found: scored.length > 0 };
}

function formatComplaint(db, c, { withEvents = false } = {}) {
  const out = {
    id: c.id,
    reference: c.reference,
    category: c.category,
    categoryLabel: COMPLAINT_CATEGORIES[c.category].label,
    description: cleanText(c.description, 500),
    status: c.status,
    priority: c.priority,
    transactionId: c.transaction_id,
    slaDueDate: c.sla_due_date,
    overdue: !['resolved', 'closed'].includes(c.status) && c.sla_due_date < today(),
    daysOpen: daysBetween(c.created_at.slice(0, 10), today()),
    resolution: c.resolution,
    createdAt: c.created_at,
    updatedAt: c.updated_at
  };
  if (withEvents) out.timeline = db.all('SELECT status, note, created_at FROM complaint_events WHERE complaint_id = :id ORDER BY id', { id: c.id });
  return out;
}

export function listComplaints(db, userId) {
  return db.all('SELECT * FROM complaints WHERE user_id = :userId ORDER BY created_at DESC', { userId }).map((c) => formatComplaint(db, c, { withEvents: true }));
}

export function getComplaint(db, userId, ref) {
  const c = db.get('SELECT * FROM complaints WHERE user_id = :userId AND (id = :ref OR reference = :ref)', { userId, ref: String(ref).toUpperCase().startsWith('CMP-') ? String(ref).toUpperCase() : ref });
  if (!c) throw notFound('I could not find that complaint reference.');
  const out = formatComplaint(db, c, { withEvents: true });
  if (c.transaction_id) out.transaction = formatTransaction(db, findTransaction(db, userId, c.transaction_id), accountsMap(db, userId));
  return out;
}

export function createComplaint(db, userId, { category, transactionId, description }) {
  if (!COMPLAINT_CATEGORIES[category]) throw badRequest('Unknown complaint category.');
  const text = cleanText(description, 500);
  if (text.length < 10) throw badRequest('Please describe the issue in a little more detail (at least 10 characters).');
  let txn = null;
  if (transactionId) txn = findTransaction(db, userId, transactionId);
  if (txn) {
    const existing = db.get(`SELECT * FROM complaints WHERE user_id = :userId AND transaction_id = :txn AND status NOT IN ('resolved', 'closed')`, { userId, txn: txn.id });
    if (existing) return { ...formatComplaint(db, existing, { withEvents: true }), alreadyExisted: true };
  }
  const id = newId('cmp');
  const now = new Date().toISOString();
  let reference;
  do reference = `CMP-${randomInt(100000, 999999)}`; while (db.get('SELECT 1 AS x FROM complaints WHERE reference = :reference', { reference }));
  const sla = addDays(today(), COMPLAINT_CATEGORIES[category].slaDays);
  db.transaction(() => {
    db.run(`INSERT INTO complaints (id, user_id, reference, category, transaction_id, description, status, priority, sla_due_date, created_at, updated_at)
            VALUES (:id, :userId, :reference, :category, :txn, :text, 'open', 'normal', :sla, :now, :now)`, { id, userId, reference, category, txn: txn?.id ?? null, text, sla, now });
    db.run(`INSERT INTO complaint_events (complaint_id, status, note, created_at) VALUES (:id, 'open', 'Complaint registered via Northstar assistant.', :now)`, { id, now });
    audit(db, { userId, event: 'complaint.created', resourceType: 'complaint', resourceId: id, details: { reference, category, transactionId: txn?.id } });
  });
  return { ...getComplaint(db, userId, id), alreadyExisted: false };
}

export function escalateComplaint(db, userId, { reference, reason }) {
  const c = getComplaint(db, userId, reference);
  if (['resolved', 'closed'].includes(c.status)) throw badRequest('This complaint is already resolved. Please raise a new complaint if the issue persists.');
  if (c.status === 'escalated') return { ...c, alreadyEscalated: true, contact: ESCALATION_CONTACT };
  const now = new Date().toISOString();
  db.transaction(() => {
    db.run(`UPDATE complaints SET status = 'escalated', priority = 'high', sla_due_date = :sla, updated_at = :now WHERE id = :id`, { id: c.id, now, sla: addDays(today(), 3) });
    db.run(`INSERT INTO complaint_events (complaint_id, status, note, created_at) VALUES (:id, 'escalated', :note, :now)`, { id: c.id, now, note: `Escalated to senior grievance officer${reason ? `: ${cleanText(reason, 200)}` : '.'}` });
    audit(db, { userId, event: 'complaint.escalated', resourceType: 'complaint', resourceId: c.id, details: { reference: c.reference } });
  });
  return { ...getComplaint(db, userId, c.id), alreadyEscalated: false, contact: ESCALATION_CONTACT };
}
