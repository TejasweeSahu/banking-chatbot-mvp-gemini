/**
 * Shared presentation helpers for service outputs. Full account and card
 * numbers never leave the service layer; only masked forms are returned.
 */

import { randomBytes, createHash } from 'node:crypto';
import { money } from '../lib/money.js';

export const maskNumber = (value) => `••${String(value).slice(-4)}`;

export function newId(prefix) {
  return `${prefix}_${randomBytes(9).toString('base64url')}`;
}

export function newReference(prefix, date) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(6);
  const suffix = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
  return `${prefix}${date.replaceAll('-', '')}${suffix}`;
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** Stable JSON (sorted keys) for fingerprints. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const categoryCache = new WeakMap();
export function getCategories(db) {
  let map = categoryCache.get(db);
  if (!map) {
    map = new Map(db.all('SELECT id, label, kind, color FROM categories').map((c) => [c.id, c]));
    categoryCache.set(db, map);
  }
  return map;
}

export function expenseCategoryIds(db) {
  return [...getCategories(db).values()].filter((c) => c.kind === 'expense').map((c) => c.id);
}

export function formatCategory(db, id) {
  const c = getCategories(db).get(id);
  return c ? { id: c.id, label: c.label, color: c.color } : { id, label: id, color: '#8d99ae' };
}

/** Strip control characters and cap length on free text that may reach the model or UI. */
export function cleanText(value, max = 200) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f​-‏‪-‮]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function formatTransaction(db, row, accountsById) {
  const account = accountsById?.get(row.account_id);
  const signed = row.direction === 'credit' ? row.amount_paise : -row.amount_paise;
  return {
    id: row.id,
    date: row.date,
    postedAt: row.posted_at,
    description: cleanText(row.description),
    merchant: cleanText(row.merchant, 80),
    category: formatCategory(db, row.category_id),
    direction: row.direction,
    amount: money(row.amount_paise),
    signedAmount: money(signed),
    status: row.status,
    channel: row.channel,
    reference: row.reference,
    failureReason: row.failure_reason ?? null,
    account: account ? { id: account.id, nickname: account.nickname, maskedNumber: maskNumber(account.account_number) } : { id: row.account_id }
  };
}
