/**
 * Assistant turn orchestrator.
 *
 *   user message ─► history (DB, context-budgeted) ─► Gemini (streaming, function calling)
 *        ▲                                              │ function calls
 *        │                                              ▼
 *   persisted reply ◄─ text deltas / UI blocks ◄─ tool executor ─► service layer
 *
 * Gemini decides which tools to call and phrases the answer; the backend owns
 * validation, data and execution. Without GEMINI_API_KEY a deterministic local
 * router (demoAgent) drives the same tool registry.
 */

import { FunctionCallingConfigMode } from '@google/genai';
import { executeTool, getFunctionDeclarations, toModelView, toolLabel } from '../tools/executor.js';
import { appendMessage, buildModelHistory } from '../services/conversationService.js';
import { buildSystemInstruction } from './prompt.js';
import { LLM_USER_MESSAGES, LLMError, classifyError, withRetry } from './geminiClient.js';
import { runDemoAgent } from './demoAgent.js';
import { canonicalJson } from '../services/common.js';
import { logger } from '../lib/logger.js';
import { today } from '../lib/dates.js';

export const LIMITS = { maxSteps: 6, maxToolCallsPerTurn: 10, maxCallsPerStep: 5 };

const SUGGESTIONS = {
  get_accounts: ['Show my recent transactions', 'How much did I spend this month?', 'What payments are coming up?'],
  search_transactions: ['Check for duplicate charges', 'Compare my spending with last month', 'Show my five largest transactions'],
  get_spending_summary: ['Compare my spending with last month', 'Show my five largest transactions', 'How are my budgets doing?'],
  compare_spending: ['Show unusual spending this month', 'How much can I safely save this month?', 'How are my budgets doing?'],
  get_top_transactions: ['Why did my expenses increase this month?', 'Check for duplicate charges', 'How much did I spend on food?'],
  get_recurring_payments: ['What payments are due in the next 7 days?', 'How much can I safely save this month?'],
  get_upcoming_payments: ['Pay my electricity bill', 'Which subscriptions am I paying for?'],
  get_savings_capacity: ['How are my budgets doing?', 'Which subscriptions am I paying for?', 'Move ₹2,000 to my Family Savings'],
  get_budgets: ['How much did I spend on food?', 'Set my shopping budget to ₹8,000'],
  find_duplicate_charges: ['Raise a complaint about the duplicate charge', 'Show my recent transactions'],
  find_unusual_spending: ['Why did my expenses increase this month?', 'Block my card'],
  explain_transaction: ['Raise a complaint about this', 'Show similar transactions'],
  get_complaints: ['Escalate my complaint', 'How long do refunds take?'],
  raise_complaint: ['Track my complaints', 'What happens next?'],
  search_help_articles: ['Track my complaints', 'Show my pending transactions'],
  get_cards: ['Block my debit card', 'Show my recent card transactions'],
  list_bills: ['Pay my electricity bill', 'What payments are coming up?'],
  list_beneficiaries: ['Send ₹2,000 to Priya', 'Add a new beneficiary']
};
const DEFAULT_SUGGESTIONS = ['What\'s my balance?', 'How much did I spend this month?', 'Which subscriptions am I paying for?'];

function suggestionsFor(toolRuns) {
  if (toolRuns.some((t) => ['awaiting_confirmation', 'needs_clarification', 'needs_input'].includes(t.status))) return [];
  for (let i = toolRuns.length - 1; i >= 0; i -= 1) {
    if (toolRuns[i].status === 'success' && SUGGESTIONS[toolRuns[i].name]) return SUGGESTIONS[toolRuns[i].name];
  }
  return DEFAULT_SUGGESTIONS;
}

/** Amounts in the reply that do not appear in any tool data this turn (or the user's message). */
export function findUnverifiedAmounts(text, toolPayloads, userMessage) {
  const known = JSON.stringify(toolPayloads) + userMessage;
  const amounts = text.match(/₹\s?[\d,]+(?:\.\d{1,2})?/g) ?? [];
  const norm = (s) => s.replace(/[₹\s,]/g, '').replace(/\.0+$/, '').replace(/(\.\d)0$/, '$1');
  const knownNorm = new Set((known.match(/₹\s?[\d,]+(?:\.\d{1,2})?|\b\d[\d,]*(?:\.\d{1,2})?\b/g) ?? []).map(norm));
  return amounts.filter((a) => !knownNorm.has(norm(a)));
}

/**
 * Run one assistant turn. `emit(event, data)` streams progress to the client.
 * Returns the persisted assistant message.
 */
export async function runAssistantTurn({ db, user, conversationId, message, llm, emit = () => {}, signal }) {
  const ctx = { db, user, conversationId };
  const toolRuns = [];
  const blocks = [];
  const contexts = [];
  const toolPayloads = [];

  const onTool = (name, args, envelope) => {
    toolRuns.push({ name, label: toolLabel(name), status: envelope.status, durationMs: envelope.durationMs });
    toolPayloads.push(envelope.data);
    if (envelope.context) contexts.push(envelope.context);
    for (const block of envelope.blocks ?? []) {
      blocks.push(block);
      emit('block', block);
    }
  };

  let text;
  let mode;
  try {
    if (llm?.client) {
      mode = 'gemini';
      text = await runGemini({ ctx, llm, emit, signal, onTool });
    } else {
      mode = 'demo';
      text = runDemoAgent({ ctx, message, emit, onTool });
      emit('text', { delta: text });
    }
  } catch (raw) {
    const error = classifyError(raw);
    logger.error('assistant_turn_failed', { kind: error.kind, status: error.status, cause: error.cause });
    text = LLM_USER_MESSAGES[error.kind] ?? LLM_USER_MESSAGES.unknown;
    if (error.kind === 'rate_limited' && error.retryAfterMs) text = `The assistant has reached its request limit for the moment. Please try again in about ${Math.ceil(error.retryAfterMs / 1000)} seconds.`;
    emit('error', { kind: error.kind, message: text, retryable: error.retryable });
    mode = mode ?? 'gemini';
  }

  const unverified = mode === 'gemini' ? findUnverifiedAmounts(text, toolPayloads, message) : [];
  if (unverified.length) logger.warn('unverified_amounts_in_reply', { amounts: unverified });

  const suggestions = suggestionsFor(toolRuns);
  const saved = appendMessage(db, conversationId, {
    role: 'assistant',
    content: text,
    blocks: [...blocks, ...(suggestions.length ? [{ type: 'suggestions', items: suggestions }] : [])],
    tools: toolRuns,
    modelContext: contexts.join('\n') || null
  });
  return { id: saved.id, createdAt: saved.createdAt, content: text, blocks, tools: toolRuns, suggestions, mode, unverifiedAmounts: unverified };
}

async function runGemini({ ctx, llm, emit, signal, onTool }) {
  const history = buildModelHistory(ctx.db, ctx.conversationId);
  const contents = history.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.text }] }));
  const config = {
    systemInstruction: buildSystemInstruction({ firstName: ctx.user.firstName, role: ctx.user.role, today: today() }),
    tools: [{ functionDeclarations: getFunctionDeclarations() }],
    toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } },
    ...(llm.temperature != null ? { temperature: llm.temperature } : {}),
    ...(llm.thinkingLevel ? { thinkingConfig: { thinkingLevel: llm.thinkingLevel } } : {}),
    maxOutputTokens: 2048
  };

  const seenCalls = new Map();
  let totalCalls = 0;
  let finalText = '';
  let malformedRetries = 0;

  for (let step = 0; step < LIMITS.maxSteps; step += 1) {
    const { parts, text, calls, finishReason } = await streamStep({ llm, contents, config, emit, signal });

    if (!calls.length) {
      if (finishReason === 'MALFORMED_FUNCTION_CALL' && malformedRetries < 1) {
        malformedRetries += 1;
        logger.warn('gemini_malformed_function_call', { step });
        continue; // retry the same step once
      }
      finalText += text;
      if (!finalText.trim()) {
        if (['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII'].includes(finishReason)) throw new LLMError('safety', 'blocked by safety filter');
        throw new LLMError('malformed', `empty response (finishReason=${finishReason ?? 'none'})`);
      }
      if (finishReason === 'MAX_TOKENS') finalText += '\n\n(Response shortened.)';
      return finalText.trim();
    }

    finalText += text;
    contents.push({ role: 'model', parts }); // keeps thought signatures intact
    const responses = [];
    for (const call of calls.slice(0, LIMITS.maxCallsPerStep)) {
      let envelope;
      const key = `${call.name}:${canonicalJson(call.args ?? {})}`;
      if (seenCalls.has(key)) {
        envelope = { ...seenCalls.get(key), blocks: [], context: undefined, note: 'Duplicate call in this turn; returning the earlier result.' };
      } else if (totalCalls >= LIMITS.maxToolCallsPerTurn) {
        envelope = { status: 'error', data: { code: 'tool_budget_exhausted', message: 'Too many tool calls this turn. Answer with the information already gathered.' }, blocks: [] };
      } else {
        totalCalls += 1;
        emit('tool_start', { name: call.name, label: toolLabel(call.name) });
        envelope = executeTool(ctx, call.name, call.args);
        seenCalls.set(key, envelope);
        emit('tool_end', { name: call.name, status: envelope.status, durationMs: envelope.durationMs });
        onTool(call.name, call.args, envelope);
      }
      responses.push({ functionResponse: { name: call.name, ...(call.id ? { id: call.id } : {}), response: { status: envelope.status, ...toModelView(envelope.data ?? {}) } } });
    }
    for (const call of calls.slice(LIMITS.maxCallsPerStep)) {
      responses.push({ functionResponse: { name: call.name, ...(call.id ? { id: call.id } : {}), response: { status: 'error', code: 'too_many_parallel_calls', message: 'Call this tool again in a later step if still needed.' } } });
    }
    contents.push({ role: 'user', parts: responses });
  }

  logger.warn('gemini_step_limit_reached');
  return (finalText.trim() ? `${finalText.trim()}\n\n` : '') + 'I gathered what I could but could not finish this request in one go. Please try rephrasing or ask a narrower question.';
}

function collectParts(candidate, acc, emit) {
  for (const part of candidate.content?.parts ?? []) {
    acc.parts.push(part);
    if (part.functionCall) {
      if (!part.functionCall.name || typeof part.functionCall.name !== 'string') throw new LLMError('malformed', 'function call without a name');
      acc.calls.push({ name: part.functionCall.name, args: part.functionCall.args ?? {}, id: part.functionCall.id });
    } else if (typeof part.text === 'string' && !part.thought && part.text) {
      acc.text += part.text;
      acc.emitted = true;
      emit('text', { delta: part.text });
    }
  }
}

/**
 * One model call. Streams when supported; in "auto" mode a stream that fails
 * before its first chunk (timeout/network) switches this process to
 * non-streaming generateContent. Transient failures are retried with backoff,
 * but never after text has reached the client, and timeouts at most once
 * (each timeout retry would multiply the user's wait).
 */
async function streamStep({ llm, contents, config, emit, signal }) {
  let emitted = false;
  let timeoutRetries = 0;
  const state = llm.state ?? (llm.state = { streamingUnavailable: llm.streaming === 'off' });
  return withRetry(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), llm.timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const started = Date.now();
    const progress = setInterval(() => emit('status', { message: 'Still working on it…', elapsedMs: Date.now() - started }), 8000);
    const useStream = !state.streamingUnavailable;
    let gotChunk = false;
    const acc = { parts: [], calls: [], text: '', emitted: false };
    let finishReason;
    try {
      const request = { model: llm.model, contents, config: { ...config, abortSignal: controller.signal } };
      if (useStream) {
        const stream = await llm.client.models.generateContentStream(request);
        for await (const chunk of stream) {
          gotChunk = true;
          clearInterval(progress);
          const candidate = chunk?.candidates?.[0];
          if (!candidate) {
            if (chunk?.promptFeedback?.blockReason) finishReason = 'SAFETY';
            continue;
          }
          finishReason = candidate.finishReason ?? finishReason;
          collectParts(candidate, acc, emit);
          emitted ||= acc.emitted;
        }
      } else {
        const response = await llm.client.models.generateContent(request);
        const candidate = response?.candidates?.[0];
        if (!candidate) finishReason = response?.promptFeedback?.blockReason ? 'SAFETY' : 'NO_CANDIDATE';
        else {
          finishReason = candidate.finishReason;
          collectParts(candidate, acc, emit);
          emitted ||= acc.emitted;
        }
      }
      return { parts: acc.parts, text: acc.text, calls: acc.calls, finishReason };
    } catch (raw) {
      const error = classifyError(raw);
      if (useStream && !gotChunk && llm.streaming === 'auto' && ['timeout', 'network'].includes(error.kind)) {
        state.streamingUnavailable = true;
        logger.warn('gemini_streaming_disabled', { reason: error.kind });
      }
      throw error;
    } finally {
      clearTimeout(timer);
      clearInterval(progress);
      signal?.removeEventListener('abort', onAbort);
    }
  }, {
    maxRetries: llm.maxRetries,
    sleep: llm.sleep,
    signal,
    shouldRetry: (error) => {
      if (emitted) return false;
      if (error.kind === 'timeout') return timeoutRetries++ < 1;
      return true;
    },
    onRetry: ({ attempt, delayMs, kind }) => {
      logger.warn('gemini_retry', { attempt, delayMs, kind });
      emit('status', { message: kind === 'rate_limited' ? `High demand. Retrying in ${Math.ceil(delayMs / 1000)}s…` : 'Reconnecting to the assistant…', attempt });
    }
  });
}
