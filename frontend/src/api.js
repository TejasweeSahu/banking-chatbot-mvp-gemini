/**
 * API client. Cookies carry the session (HttpOnly; JS never sees the token).
 * Every request sends the CSRF header the backend requires.
 */

export class ApiError extends Error {
  constructor(message, { status, code, details } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const HEADERS = { 'X-Requested-With': 'northstar' };

export async function api(path, { method = 'GET', body, signal } = {}) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      signal,
      credentials: 'same-origin',
      headers: { ...HEADERS, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new ApiError('Could not reach Northstar. Check your connection and try again.', { status: 0, code: 'network' });
  }
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && path !== '/auth/login') window.dispatchEvent(new Event('northstar:signed-out'));
    throw new ApiError(json?.error?.message ?? 'Something went wrong. Please try again.', { status: res.status, code: json?.error?.code, details: json?.error?.details ?? json });
  }
  return json;
}

/**
 * POST /api/chat and parse the Server-Sent Events stream.
 * onEvent(event, data) is called for meta, tool_start, tool_end, block, text, status, error, done.
 */
export async function streamChat({ message, conversationId, signal, onEvent }) {
  let res;
  try {
    res = await fetch('/api/chat', {
      method: 'POST',
      signal,
      credentials: 'same-origin',
      headers: { ...HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, ...(conversationId ? { conversationId } : {}) })
    });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new ApiError('Could not reach the assistant. Check your connection and try again.', { status: 0, code: 'network' });
  }
  if (!res.ok) {
    const json = await res.json().catch(() => null);
    if (res.status === 401) window.dispatchEvent(new Event('northstar:signed-out'));
    throw new ApiError(json?.error?.message ?? 'The assistant could not take that message.', { status: res.status, code: json?.error?.code });
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let event = 'message';
      let data = '';
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7);
        else if (line.startsWith('data: ')) data += line.slice(6);
      }
      if (!data) continue;
      try {
        onEvent(event, JSON.parse(data));
      } catch {
        // ignore a malformed frame rather than breaking the stream
      }
    }
  }
}
