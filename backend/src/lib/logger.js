/**
 * Structured JSON-lines logger with request-ID propagation (AsyncLocalStorage)
 * and recursive redaction of secrets and sensitive identifiers.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from '../config.js';

export const requestContext = new AsyncLocalStorage();

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const SECRET_SUBSTRINGS = ['password', 'passwd', 'secret', 'token', 'apikey', 'authorization', 'cookie'];
const SECRET_EXACT = new Set(['otp', 'pin', 'cvv', 'mpin', 'upipin']);
const ACCOUNT_KEYS = new Set(['accountnumber', 'cardnumber', 'vpa', 'ifsc', 'upiid']);
const normalizeKey = (key) => key.toLowerCase().replace(/[-_]/g, '');
const isSecretKey = (key) => {
  const k = normalizeKey(key);
  return SECRET_EXACT.has(k) || SECRET_SUBSTRINGS.some((s) => k.includes(s));
};

export function maskIdentifier(value) {
  const text = String(value ?? '');
  return text.length <= 4 ? '****' : `****${text.slice(-4)}`;
}

/** Remove secrets, mask account-like identifiers, and mask long digit runs in free text. */
export function redact(value, depth = 0) {
  if (depth > 6) return '[depth]';
  if (value == null) return value;
  if (typeof value === 'string') return value.replace(/\b\d{9,18}\b/g, (m) => maskIdentifier(m)).slice(0, 2000);
  if (typeof value !== 'object') return value;
  if (value instanceof Error) return { name: value.name, message: redact(value.message), status: value.status, code: value.code };
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  const out = {};
  for (const [key, v] of Object.entries(value)) {
    if (isSecretKey(key)) out[key] = '[redacted]';
    else if (ACCOUNT_KEYS.has(normalizeKey(key))) out[key] = maskIdentifier(v);
    else out[key] = redact(v, depth + 1);
  }
  return out;
}

function write(level, msg, fields = {}) {
  if (LEVELS[level] < LEVELS[config.logLevel]) return;
  const ctx = requestContext.getStore();
  const line = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(ctx?.requestId ? { requestId: ctx.requestId } : {}),
    ...(ctx?.userId ? { userId: ctx.userId } : {}),
    ...redact(fields)
  };
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(`${JSON.stringify(line)}\n`);
}

export const logger = {
  debug: (msg, fields) => write('debug', msg, fields),
  info: (msg, fields) => write('info', msg, fields),
  warn: (msg, fields) => write('warn', msg, fields),
  error: (msg, fields) => write('error', msg, fields)
};
