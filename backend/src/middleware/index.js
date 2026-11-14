/**
 * HTTP middleware: request IDs + structured access logs, CSRF/origin checks,
 * session authentication, in-memory rate limiting and safe error responses.
 */

import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { AppError, forbidden, tooManyRequests, unauthorized } from '../lib/errors.js';
import { logger, requestContext } from '../lib/logger.js';
import { authenticate } from '../services/authService.js';

export const SESSION_COOKIE = 'ns_session';
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_VALUE = 'northstar';

export function requestId() {
  return (req, res, next) => {
    const incoming = req.get('x-request-id');
    const id = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : `req_${randomBytes(8).toString('hex')}`;
    req.id = id;
    res.setHeader('X-Request-Id', id);
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      logger.info('http_request', { method: req.method, path: req.path, status: res.statusCode, durationMs: Math.round(ms) });
    });
    requestContext.run({ requestId: id, ip: req.ip }, next);
  };
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 1) continue;
    const key = part.slice(0, idx).trim();
    try {
      out[key] = decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      // ignore malformed cookie values
    }
  }
  return out;
}

export function sessionCookieOptions() {
  return { httpOnly: true, sameSite: 'strict', secure: config.cookieSecure, path: '/api', maxAge: config.sessionTtlMs };
}

/**
 * CSRF defence for cookie-authenticated, state-changing requests:
 * SameSite=Strict cookie + required custom header (cannot be sent cross-site
 * without a CORS preflight, which our CORS policy rejects) + Origin allowlist.
 */
export function csrfProtection() {
  return (req, _res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.get(CSRF_HEADER) !== CSRF_VALUE) return next(forbidden('Missing or invalid request header.'));
    const origin = req.get('origin');
    if (origin && !isAllowedOrigin(origin, req)) return next(forbidden('Cross-origin request blocked.'));
    return next();
  };
}

export function isAllowedOrigin(origin, req) {
  if (config.frontendOrigins.includes(origin)) return true;
  try {
    return new URL(origin).host === req.get('host');
  } catch {
    return false;
  }
}

export function requireAuth(db) {
  return (req, _res, next) => {
    const token = parseCookies(req.get('cookie'))[SESSION_COOKIE];
    const user = authenticate(db, token);
    if (!user) return next(unauthorized());
    req.user = user;
    const store = requestContext.getStore();
    if (store) store.userId = user.id;
    return next();
  };
}

/** Fixed-window limiter keyed per user (or IP). Suitable for a single instance. */
export function rateLimit({ name, windowMs, max, key = (req) => req.user?.id ?? req.ip }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, windowMs).unref();
  return (req, res, next) => {
    const k = `${name}:${key(req)}`;
    const now = Date.now();
    let entry = hits.get(k);
    if (!entry || entry.reset <= now) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(k, entry);
    }
    entry.count += 1;
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, max - entry.count)));
    if (entry.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((entry.reset - now) / 1000)));
      logger.warn('rate_limited', { limiter: name });
      return next(tooManyRequests());
    }
    return next();
  };
}

export function notFoundHandler() {
  return (_req, res) => res.status(404).json({ error: { code: 'not_found', message: 'Not found.' } });
}

export function errorHandler() {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, _next) => {
    if (err instanceof AppError) {
      if (err.status >= 500) logger.error('app_error', { error: err });
      return res.status(err.status).json({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) }, requestId: req.id });
    }
    // Client errors raised by Express internals (e.g. serve-static 404/403 via http-errors).
    if (Number.isInteger(err?.status) && err.status >= 400 && err.status < 500 && !err.type) {
      return res.status(err.status).type('text/plain').send(err.status === 404 ? 'Not found' : 'Request not allowed');
    }
    if (err?.type === 'entity.parse.failed' || err?.type === 'entity.too.large') {
      return res.status(err.status ?? 400).json({ error: { code: 'invalid_body', message: 'The request body is invalid.' }, requestId: req.id });
    }
    logger.error('unhandled_error', { error: err, stack: err?.stack?.split('\n').slice(0, 5).join(' | ') });
    return res.status(500).json({ error: { code: 'internal_error', message: 'Something went wrong on our side. Please try again.' }, requestId: req.id });
  };
}

/** Mask secrets a user might paste into chat before they are stored or sent to the LLM. */
export function maskSensitiveInput(text) {
  let masked = false;
  let out = text.replace(/\b(?:\d[ -]?){15,18}\d\b/g, (m) => { masked = true; return `[number ending ${m.replace(/\D/g, '').slice(-4)}]`; });
  out = out.replace(/\b(\d{9,14})\b/g, (m) => { masked = true; return `[number ending ${m.slice(-4)}]`; });
  out = out.replace(/\b(otp|pin|mpin|upi pin|cvv|password|passcode)\b(\s*(?:is|:|=)?\s*)(\S+)/gi, (_m, label, sep) => { masked = true; return `${label}${sep}[redacted]`; });
  return { text: out, masked };
}
