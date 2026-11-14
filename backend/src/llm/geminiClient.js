/**
 * Gemini client wrapper (official @google/genai SDK): error classification and
 * retry with exponential backoff + jitter. Gemini is the only LLM provider.
 */

import { GoogleGenAI } from '@google/genai';

export class LLMError extends Error {
  constructor(kind, message, { retryable = false, status, cause } = {}) {
    super(message);
    this.name = 'LLMError';
    this.kind = kind;
    this.retryable = retryable;
    this.status = status;
    this.cause = cause;
  }
}

/** User-safe messages per failure kind (never include provider internals). */
export const LLM_USER_MESSAGES = {
  rate_limited: 'The assistant is receiving a lot of requests right now. Please wait a few seconds and try again.',
  overloaded: 'The assistant service is temporarily unavailable. Please try again shortly.',
  timeout: 'The assistant took too long to respond. Please try again.',
  network: 'The assistant could not be reached. Check your connection and try again.',
  auth: 'The assistant is not configured correctly. Please contact support.',
  invalid_request: 'The assistant could not process that request. Please rephrase and try again.',
  safety: 'I can\'t help with that request. I can help with balances, transactions, payments, cards and support.',
  malformed: 'The assistant returned an unexpected response. Please try again.',
  unknown: 'Something went wrong while generating a response. Please try again.'
};

const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT']);

export function classifyError(error) {
  if (error instanceof LLMError) return error;
  const status = Number(error?.status ?? error?.code ?? error?.response?.status) || undefined;
  const message = String(error?.message ?? '');
  const causeCode = error?.cause?.code ?? error?.code;
  if (error?.name === 'AbortError' || /aborted|timed? ?out/i.test(message)) return new LLMError('timeout', 'Gemini request timed out', { retryable: true, cause: error });
  if (status === 429 || /RESOURCE_EXHAUSTED|rate limit|quota/i.test(message)) return new LLMError('rate_limited', 'Gemini rate limit', { retryable: true, status: 429, cause: error });
  if ([500, 502, 503, 504].includes(status) || /UNAVAILABLE|overloaded|INTERNAL/i.test(message)) return new LLMError('overloaded', 'Gemini unavailable', { retryable: true, status, cause: error });
  if (status === 401 || status === 403 || /API key|PERMISSION_DENIED|UNAUTHENTICATED/i.test(message)) return new LLMError('auth', 'Gemini authentication failed', { status, cause: error });
  if (status === 400 || status === 404 || /INVALID_ARGUMENT|NOT_FOUND/i.test(message)) return new LLMError('invalid_request', 'Gemini rejected the request', { status, cause: error });
  if (NETWORK_CODES.has(causeCode) || /fetch failed|network|socket/i.test(message)) return new LLMError('network', 'Network error calling Gemini', { retryable: true, cause: error });
  return new LLMError('unknown', 'Unexpected Gemini error', { cause: error });
}

/** Server-provided retry delay (e.g. "retryDelay": "23s", possibly inside escaped JSON). */
export function serverRetryDelayMs(error) {
  const text = String(error?.cause?.message ?? error?.message ?? '');
  const match = /retryDelay[\\"']*\s*[:=]\s*[\\"']*(\d+(?:\.\d+)?)s/i.exec(text) ?? /retry in (\d+(?:\.\d+)?)s/i.exec(text);
  return match ? Math.ceil(Number(match[1]) * 1000) : null;
}

const LONG_WAIT_MS = 5000;
const MAX_WAIT_MS = 30_000;

export function backoffDelay(attempt, { baseMs = 500, maxMs = 8000, random = Math.random } = {}) {
  const exp = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.round(exp / 2 + random() * (exp / 2)); // "equal jitter"
}

const defaultSleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new LLMError('timeout', 'aborted')); }, { once: true });
});

/**
 * Run fn(attempt) with retries for retryable failures.
 * shouldRetry(error) lets the caller veto retries (e.g. after streaming started).
 */
export async function withRetry(fn, { maxRetries = 3, sleep = defaultSleep, onRetry, shouldRetry = () => true, signal } = {}) {
  let longWaits = 0;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (raw) {
      const error = classifyError(raw);
      const serverDelay = serverRetryDelayMs(raw);
      if (serverDelay) error.retryAfterMs = serverDelay;
      // Wait as long as the server asks, but only once for a long wait, and never beyond MAX_WAIT_MS.
      const delay = serverDelay ?? backoffDelay(attempt);
      const tooLong = delay > MAX_WAIT_MS || (delay > LONG_WAIT_MS && longWaits >= 1);
      if (!error.retryable || attempt >= maxRetries || tooLong || !shouldRetry(error) || signal?.aborted) throw error;
      if (delay > LONG_WAIT_MS) longWaits += 1;
      onRetry?.({ attempt: attempt + 1, delayMs: delay, kind: error.kind });
      await sleep(delay, signal);
    }
  }
}

export function createGeminiClient(geminiConfig) {
  if (!geminiConfig.apiKey) return null;
  return new GoogleGenAI({ apiKey: geminiConfig.apiKey });
}
