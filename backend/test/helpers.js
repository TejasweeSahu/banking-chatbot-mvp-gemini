/**
 * Test helpers: fresh seeded in-memory database per test, pinned clock,
 * a scripted fake Gemini client and an HTTP client with a cookie jar.
 */

import { openDatabase } from '../src/db/database.js';
import { seedDatabase } from '../src/db/seed.js';
import { setToday } from '../src/lib/dates.js';
import { createApp } from '../src/app.js';
import { publicUser } from '../src/services/authService.js';

export const ANCHOR = '2026-11-14';

export function freshDb() {
  setToday(ANCHOR);
  const db = openDatabase(':memory:');
  seedDatabase(db, { anchor: ANCHOR });
  return db;
}

export function userCtx(db, id = 'usr_tejas') {
  return publicUser(db.get('SELECT * FROM users WHERE id = :id', { id }));
}

export const balanceOf = (db, accountId) => db.get('SELECT balance_paise FROM accounts WHERE id = :accountId', { accountId }).balance_paise;

/**
 * Fake Gemini client. `script` is an array of steps; each step is either
 *   { parts: [...], finishReason? }   → returned as a response / single stream chunk
 *   { error: Error }                    → thrown
 *   { hang: true }                      → never resolves until aborted
 * Records every request in `calls`.
 */
export function fakeGemini(script) {
  const calls = [];
  let i = 0;
  const next = (request) => {
    calls.push(structuredClone({ ...request, config: { ...request.config, abortSignal: undefined } }));
    const step = script[Math.min(i, script.length - 1)];
    i += 1;
    return { step, signal: request.config?.abortSignal };
  };
  const hang = (signal) => new Promise((_, reject) => {
    signal?.addEventListener('abort', () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })), { once: true });
  });
  const response = (step) => ({ candidates: [{ content: { role: 'model', parts: step.parts ?? [] }, finishReason: step.finishReason ?? 'STOP' }] });
  return {
    calls,
    models: {
      async generateContent(request) {
        const { step, signal } = next(request);
        if (step.hang) await hang(signal);
        if (step.error) throw step.error;
        return response(step);
      },
      async generateContentStream(request) {
        const { step, signal } = next(request);
        if (step.hang) await hang(signal);
        if (step.error) throw step.error;
        return (async function* stream() {
          // Split text parts into several chunks to exercise incremental handling.
          for (const part of step.parts ?? []) {
            if (part.text && part.text.length > 8) {
              yield { candidates: [{ content: { role: 'model', parts: [{ text: part.text.slice(0, 8) }] } }] };
              yield { candidates: [{ content: { role: 'model', parts: [{ ...part, text: part.text.slice(8) }] } }] };
            } else {
              yield { candidates: [{ content: { role: 'model', parts: [part] } }] };
            }
          }
          yield { candidates: [{ content: { role: 'model', parts: [] }, finishReason: step.finishReason ?? 'STOP' }] };
        }());
      }
    }
  };
}

export const apiError = (status, message = 'error') => Object.assign(new Error(message), { status });

export function llmFor(client, overrides = {}) {
  return { client, model: 'gemini-test', timeoutMs: 2000, maxRetries: 3, streaming: 'auto', sleep: async () => {}, state: { streamingUnavailable: false }, ...overrides };
}

/** Start the real Express app on an ephemeral port. */
export async function startServer({ db = freshDb(), llm = null } = {}) {
  const app = createApp({ db, llm });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, base, close: () => new Promise((r) => server.close(r)) };
}

export function httpClient(base) {
  let cookie = '';
  const request = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(method !== 'GET' ? { 'X-Requested-With': 'northstar' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* SSE or empty */ }
    return { status: res.status, headers: res.headers, json, text };
  };
  return {
    get: (p, h) => request('GET', p, undefined, h),
    post: (p, b, h) => request('POST', p, b ?? {}, h),
    put: (p, b, h) => request('PUT', p, b, h),
    del: (p, h) => request('DELETE', p, undefined, h),
    raw: request,
    get cookie() { return cookie; },
    async login(username = 'tejas', password = 'Northstar@2026') {
      return request('POST', '/api/auth/login', { username, password });
    },
    /** POST /api/chat and parse the SSE stream into [{event, data}]. */
    async chat(message, conversationId) {
      const res = await request('POST', '/api/chat', { message, ...(conversationId ? { conversationId } : {}) });
      if (res.status !== 200) return { status: res.status, json: res.json, events: [] };
      const events = res.text.split('\n\n').filter((c) => c.startsWith('event:')).map((chunk) => {
        const [eventLine, dataLine] = chunk.split('\n');
        return { event: eventLine.slice(7), data: JSON.parse(dataLine.slice(6)) };
      });
      const meta = events.find((e) => e.event === 'meta')?.data;
      const done = events.find((e) => e.event === 'done')?.data;
      return { status: 200, events, meta, done, blocks: events.filter((e) => e.event === 'block').map((e) => e.data) };
    }
  };
}
