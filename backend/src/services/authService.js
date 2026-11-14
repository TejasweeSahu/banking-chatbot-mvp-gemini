/**
 * Authentication: password login with lockout, opaque session tokens (only a
 * SHA-256 hash is stored), absolute + idle expiry, and role-based scopes.
 */

import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { unauthorized, tooManyRequests } from '../lib/errors.js';
import { DUMMY_HASH, verifyPassword } from '../lib/password.js';
import { newId, sha256 } from './common.js';
import { audit } from './auditService.js';

const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MS = 15 * 60_000;
const TOUCH_INTERVAL_MS = 60_000;

export const ROLE_SCOPES = {
  customer: ['accounts:read', 'transactions:read', 'payments:write', 'cards:write', 'beneficiaries:write', 'budgets:write', 'support:write'],
  viewer: ['accounts:read', 'transactions:read']
};

export function hasScope(user, scope) {
  return (ROLE_SCOPES[user.role] ?? []).includes(scope);
}

export function publicUser(u) {
  return { id: u.id, username: u.username, fullName: u.full_name, firstName: u.full_name.split(' ')[0], role: u.role, scopes: ROLE_SCOPES[u.role] };
}

export function login(db, { username, password, ip, userAgent }) {
  const user = db.get('SELECT * FROM users WHERE username = :username', { username });
  const now = Date.now();
  if (user?.locked_until && Date.parse(user.locked_until) > now) {
    audit(db, { userId: user.id, event: 'auth.login', outcome: 'denied', details: { reason: 'locked' } });
    throw tooManyRequests('Too many failed sign-in attempts. Please try again in a few minutes.');
  }
  const ok = verifyPassword(password, user?.password_hash ?? DUMMY_HASH) && Boolean(user);
  if (!ok) {
    if (user) {
      const failed = user.failed_logins + 1;
      const lock = failed >= MAX_FAILED_LOGINS ? new Date(now + LOCKOUT_MS).toISOString() : null;
      db.run('UPDATE users SET failed_logins = :failed, locked_until = :lock WHERE id = :id', { failed: lock ? 0 : failed, lock, id: user.id });
    }
    audit(db, { userId: user?.id ?? null, event: 'auth.login', outcome: 'failure', details: { reason: 'bad_credentials' } });
    throw unauthorized('Incorrect username or password.');
  }
  db.run('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = :id', { id: user.id });
  const token = randomBytes(32).toString('base64url');
  const created = new Date(now).toISOString();
  db.run(`INSERT INTO sessions (id, user_id, token_hash, created_at, last_seen_at, expires_at, ip, user_agent)
          VALUES (:id, :userId, :hash, :created, :created, :expires, :ip, :ua)`, {
    id: newId('ses'), userId: user.id, hash: sha256(token), created, expires: new Date(now + config.sessionTtlMs).toISOString(), ip: ip ?? null, ua: String(userAgent ?? '').slice(0, 200)
  });
  audit(db, { userId: user.id, event: 'auth.login', outcome: 'success' });
  return { token, user: publicUser(user) };
}

export function authenticate(db, token) {
  if (!token || typeof token !== 'string' || token.length > 100) return null;
  const row = db.get(`SELECT s.id AS session_id, s.last_seen_at, s.expires_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = :hash`, { hash: sha256(token) });
  if (!row) return null;
  const now = Date.now();
  if (Date.parse(row.expires_at) <= now || now - Date.parse(row.last_seen_at) > config.sessionIdleMs) {
    db.run('DELETE FROM sessions WHERE id = :id', { id: row.session_id });
    return null;
  }
  if (now - Date.parse(row.last_seen_at) > TOUCH_INTERVAL_MS) {
    db.run('UPDATE sessions SET last_seen_at = :now WHERE id = :id', { now: new Date(now).toISOString(), id: row.session_id });
  }
  return { ...publicUser(row), sessionId: row.session_id };
}

export function logout(db, user) {
  db.run('DELETE FROM sessions WHERE id = :id', { id: user.sessionId });
  audit(db, { userId: user.id, event: 'auth.logout' });
}
