import test from 'node:test';
import assert from 'node:assert/strict';
import { apiError, balanceOf, fakeGemini, freshDb, llmFor, userCtx } from '../helpers.js';
import { findUnverifiedAmounts, runAssistantTurn } from '../../src/llm/orchestrator.js';
import { appendMessage, createConversation, getConversation } from '../../src/services/conversationService.js';
import { backoffDelay, classifyError } from '../../src/llm/geminiClient.js';
import { TOOLS } from '../../src/tools/registry.js';
import { executeTool, getFunctionDeclarations } from '../../src/tools/executor.js';

function setup(message) {
  const db = freshDb();
  const user = userCtx(db);
  const conversation = createConversation(db, user.id, message);
  appendMessage(db, conversation.id, { role: 'user', content: message });
  return { db, user, conversationId: conversation.id };
}

async function turn(env, client, message, overrides) {
  const events = [];
  const result = await runAssistantTurn({ ...env, message, llm: llmFor(client, overrides), emit: (event, data) => events.push({ event, data }) });
  return { result, events };
}

const call = (name, args = {}, extra = {}) => ({ functionCall: { name, args, id: `call_${name}` }, ...extra });

test('tool call → backend data → model answer; thought signatures are preserved', async () => {
  const env = setup("What's my balance?");
  const client = fakeGemini([
    { parts: [call('get_accounts', {}, { thoughtSignature: 'sig-abc' })] },
    { parts: [{ text: 'Your total balance is ₹6,05,022.75.' }] }
  ]);
  const { result, events } = await turn(env, client, "What's my balance?");
  assert.equal(client.calls.length, 2);
  const second = client.calls[1].contents;
  const modelTurn = second.at(-2);
  assert.equal(modelTurn.role, 'model');
  assert.equal(modelTurn.parts[0].thoughtSignature, 'sig-abc', 'signature replayed unchanged');
  const fnResponse = second.at(-1).parts[0].functionResponse;
  assert.equal(fnResponse.name, 'get_accounts');
  assert.equal(fnResponse.id, 'call_get_accounts');
  assert.equal(fnResponse.response.status, 'success');
  assert.match(fnResponse.response.totalBalance, /^₹/, 'model receives exact formatted figures');
  assert.equal(result.blocks[0].type, 'accounts', 'UI card comes from backend data, not model text');
  assert.ok(events.some((e) => e.event === 'tool_start' && e.data.name === 'get_accounts'));
  assert.ok(events.filter((e) => e.event === 'text').length >= 2, 'text is streamed incrementally');
  const saved = getConversation(env.db, env.user.id, env.conversationId).messages.at(-1);
  assert.equal(saved.role, 'assistant');
  assert.equal(saved.content, 'Your total balance is ₹6,05,022.75.');
});

test('system instruction and tool declarations are sent; no user id is exposed to the model', async () => {
  const env = setup('hi');
  const client = fakeGemini([{ parts: [{ text: 'Hello!' }] }]);
  await turn(env, client, 'hi');
  const req = client.calls[0];
  assert.match(req.config.systemInstruction, /never execute/i);
  assert.equal(req.config.tools[0].functionDeclarations.length, TOOLS.length);
  assert.ok(!JSON.stringify(req).includes('usr_tejas'));
});

test('"Send ₹2,000 to Rahul" via Gemini asks for clarification and moves no money', async () => {
  const env = setup('Send ₹2,000 to Rahul');
  const before = balanceOf(env.db, 'acc_tejas_sav');
  const client = fakeGemini([
    { parts: [call('prepare_transfer', { recipient: 'Rahul', amount: '2000' })] },
    { parts: [{ text: 'You have two saved payees named Rahul. Which one?' }] }
  ]);
  const { result } = await turn(env, client, 'Send ₹2,000 to Rahul');
  const response = client.calls[1].contents.at(-1).parts[0].functionResponse.response;
  assert.equal(response.status, 'needs_clarification');
  assert.equal(response.options.length, 2);
  assert.equal(result.blocks[0].type, 'choices');
  assert.match(result.blocks[0].options[0].message, /^Send ₹2,000\.00 to Rahul/);
  assert.equal(balanceOf(env.db, 'acc_tejas_sav'), before);
  assert.deepEqual(result.suggestions, [], 'no generic suggestions while a choice is pending');
});

test('a prepared transfer requires the confirm endpoint; the model has no execute tool', async () => {
  const env = setup('Send 2000 to Priya');
  const before = balanceOf(env.db, 'acc_tejas_sav');
  const client = fakeGemini([
    { parts: [call('prepare_transfer', { recipient: 'Priya', amount: 2000 })] },
    { parts: [call('execute_transfer', { actionId: 'whatever' })] },
    { parts: [{ text: 'Please press Confirm.' }] }
  ]);
  const { result } = await turn(env, client, 'Send 2000 to Priya');
  const exec = client.calls[2].contents.at(-1).parts[0].functionResponse.response;
  assert.equal(exec.status, 'error');
  assert.equal(exec.code, 'unknown_tool');
  assert.equal(result.blocks[0].type, 'confirmation');
  assert.equal(result.blocks[0].action.status, 'pending');
  assert.equal(balanceOf(env.db, 'acc_tejas_sav'), before);
  assert.ok(TOOLS.every((t) => !/^(execute|confirm|approve)/.test(t.name)), 'no tool can execute an action');
});

test('invalid model arguments are rejected with field-level errors', async () => {
  const env = setup('send money');
  const client = fakeGemini([
    { parts: [call('prepare_transfer', { recipient: 'Priya', amount: -500, sneaky: true })] },
    { parts: [{ text: 'How much would you like to send?' }] }
  ]);
  await turn(env, client, 'send money');
  const r = client.calls[1].contents.at(-1).parts[0].functionResponse.response;
  assert.equal(r.status, 'error');
  assert.equal(r.code, 'invalid_arguments');
  assert.ok(r.issues.some((i) => /unknown field/.test(i.problem)));
  assert.equal(env.db.get('SELECT COUNT(*) AS n FROM pending_actions').n, 0);
});

test('429 is retried with backoff, then succeeds', async () => {
  const env = setup('hi');
  const client = fakeGemini([{ error: apiError(429, 'RESOURCE_EXHAUSTED') }, { error: apiError(429) }, { parts: [{ text: 'Hello again' }] }]);
  const { result, events } = await turn(env, client, 'hi');
  assert.equal(client.calls.length, 3);
  assert.equal(result.content, 'Hello again');
  assert.equal(events.filter((e) => e.event === 'status').length, 2);
});

test('503 exhausting retries yields a safe message, persisted to history', async () => {
  const env = setup('hi');
  const client = fakeGemini([{ error: apiError(503, 'UNAVAILABLE: overloaded') }]);
  const { result, events } = await turn(env, client, 'hi', { maxRetries: 2 });
  assert.equal(client.calls.length, 3);
  assert.match(result.content, /temporarily unavailable/);
  assert.ok(!result.content.includes('503'), 'no provider internals leak');
  assert.equal(events.find((e) => e.event === 'error').data.kind, 'overloaded');
  assert.equal(getConversation(env.db, env.user.id, env.conversationId).messages.at(-1).content, result.content);
});

test('authentication / bad-request errors are not retried', async () => {
  const env = setup('hi');
  const client = fakeGemini([{ error: apiError(401, 'API key not valid') }]);
  const { result } = await turn(env, client, 'hi');
  assert.equal(client.calls.length, 1);
  assert.match(result.content, /not configured correctly/);
});

test('timeouts abort the request and are retried at most once', async () => {
  const env = setup('hi');
  const client = fakeGemini([{ hang: true }]);
  const { events } = await turn(env, client, 'hi', { timeoutMs: 30, streaming: 'on' });
  assert.equal(client.calls.length, 2);
  assert.equal(events.find((e) => e.event === 'error').data.kind, 'timeout');
});

test('streaming that fails before the first chunk falls back to non-streaming', async () => {
  const env = setup('hi');
  const client = fakeGemini([{ hang: true }, { parts: [{ text: 'Recovered without streaming' }] }]);
  const streamCalls = [];
  const original = client.models.generateContentStream;
  client.models.generateContentStream = (req) => { streamCalls.push(1); return original(req); };
  const llm = llmFor(client, { timeoutMs: 30 });
  const r = await runAssistantTurn({ ...env, message: 'hi', llm, emit: () => {} });
  assert.equal(r.content, 'Recovered without streaming');
  assert.equal(streamCalls.length, 1);
  assert.equal(llm.state.streamingUnavailable, true);
});

test('network errors are retried', async () => {
  const env = setup('hi');
  const client = fakeGemini([{ error: Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }) }, { parts: [{ text: 'ok' }] }]);
  const { result } = await turn(env, client, 'hi');
  assert.equal(result.content, 'ok');
});

test('malformed responses: empty output and MALFORMED_FUNCTION_CALL are handled', async () => {
  const env = setup('hi');
  const empty = fakeGemini([{ parts: [], finishReason: 'STOP' }]);
  const r1 = await turn(env, empty, 'hi');
  assert.match(r1.result.content, /unexpected response/);
  const malformed = fakeGemini([{ parts: [], finishReason: 'MALFORMED_FUNCTION_CALL' }, { parts: [{ text: 'Second try worked' }] }]);
  const r2 = await turn(env, malformed, 'hi');
  assert.equal(r2.result.content, 'Second try worked');
  const safety = fakeGemini([{ parts: [], finishReason: 'SAFETY' }]);
  const r3 = await turn(env, safety, 'hi');
  assert.match(r3.result.content, /can't help with that/);
  const nameless = fakeGemini([{ parts: [{ functionCall: { args: {} } }] }]);
  const r4 = await turn(env, nameless, 'hi', { maxRetries: 0 });
  assert.match(r4.result.content, /unexpected response/);
});

test('repeated identical calls in one turn execute once; runaway loops stop', async () => {
  const env = setup('balance');
  const dup = fakeGemini([
    { parts: [call('get_accounts'), call('get_accounts')] },
    { parts: [{ text: 'done' }] }
  ]);
  await turn(env, dup, 'balance');
  assert.equal(env.db.get(`SELECT COUNT(*) AS n FROM tool_executions WHERE tool = 'get_accounts'`).n, 1);

  const loop = fakeGemini([{ parts: [call('get_budgets')] }]);
  const { result } = await turn(env, loop, 'budgets');
  assert.equal(loop.calls.length, 6);
  assert.match(result.content, /could not finish/);
});

test('context window: older history is trimmed but the conversation starts with a user turn', async () => {
  const env = setup('first');
  for (let i = 0; i < 40; i += 1) {
    appendMessage(env.db, env.conversationId, { role: i % 2 ? 'user' : 'assistant', content: `message ${i} ${'x'.repeat(1500)}` });
  }
  const client = fakeGemini([{ parts: [{ text: 'ok' }] }]);
  await turn(env, client, 'latest');
  const contents = client.calls[0].contents;
  assert.ok(contents.length <= 24);
  assert.equal(contents[0].role, 'user');
  assert.ok(JSON.stringify(contents).length < 40_000);
});

test('unverified amounts in a reply are detected', () => {
  assert.deepEqual(findUnverifiedAmounts('You spent ₹1,234.00 and have ₹99.00 left', [{ total: '₹1,234.00' }], ''), ['₹99.00']);
  assert.deepEqual(findUnverifiedAmounts('Sending ₹2,000', [], 'send 2000 to priya'), []);
});

test('error classification and backoff', () => {
  assert.equal(classifyError(apiError(429)).kind, 'rate_limited');
  assert.equal(classifyError(apiError(503)).retryable, true);
  assert.equal(classifyError(apiError(400)).retryable, false);
  assert.equal(classifyError(Object.assign(new Error('x'), { name: 'AbortError' })).kind, 'timeout');
  const d = [0, 1, 2, 3, 10].map((n) => backoffDelay(n, { random: () => 1 }));
  assert.deepEqual(d, [500, 1000, 2000, 4000, 8000]);
});

test('every tool declaration is a strict object schema generated from the validator', () => {
  for (const decl of getFunctionDeclarations()) {
    assert.equal(decl.parametersJsonSchema.type, 'object', decl.name);
    assert.equal(decl.parametersJsonSchema.additionalProperties, false, decl.name);
    assert.ok(!('$schema' in decl.parametersJsonSchema));
    assert.ok(decl.description.length > 20);
  }
});

test('executor: non-object args, nulls, oversized args, read-only scope', () => {
  const db = freshDb();
  const ctx = { db, user: userCtx(db), conversationId: null };
  assert.equal(executeTool(ctx, 'get_accounts', 'drop table').data.code, 'invalid_arguments');
  assert.equal(executeTool(ctx, 'get_accounts', [1]).data.code, 'invalid_arguments');
  assert.equal(executeTool(ctx, 'search_transactions', { status: null, limit: 3 }).status, 'success', 'nulls from the model are treated as omitted');
  assert.equal(executeTool(ctx, 'search_transactions', { query: 'x'.repeat(5000) }).data.code, 'invalid_arguments');
  assert.equal(executeTool(ctx, 'explain_transaction', { transactionId: 'txn_nope' }).data.code, 'not_found');
  const viewer = { db, user: userCtx(db, 'usr_meera'), conversationId: null };
  assert.equal(executeTool(viewer, 'prepare_transfer', { recipient: 'x', amount: 1 }).data.code, 'forbidden');
  assert.equal(executeTool(viewer, 'get_accounts', {}).status, 'success');
});

test('server retryDelay is honoured once (even inside escaped JSON), and reported to the user', async () => {
  const { serverRetryDelayMs } = await import('../../src/llm/geminiClient.js');
  const nested = '{"error":{"message":"{\\n  \\"error\\": {\\"details\\": [{\\"retryDelay\\": \\"23s\\"}]}}"}}';
  assert.equal(serverRetryDelayMs(new Error(nested)), 23000);
  assert.equal(serverRetryDelayMs(new Error('Please retry in 7.5s.')), 7500);
  const env = setup('hi');
  const waits = [];
  const quota = () => apiError(429, '"retryDelay": "12s"');
  const client = fakeGemini([{ error: quota() }, { error: quota() }, { parts: [{ text: 'never' }] }]);
  const r = await runAssistantTurn({ ...env, message: 'hi', llm: llmFor(client, { sleep: async (ms) => { waits.push(ms); } }), emit: () => {} });
  assert.deepEqual(waits, [12000], 'one long wait only');
  assert.match(r.content, /about 12 seconds/);
});
