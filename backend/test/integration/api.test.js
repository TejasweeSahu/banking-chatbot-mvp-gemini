import test from 'node:test';
import assert from 'node:assert/strict';
import { balanceOf, fakeGemini, freshDb, httpClient, llmFor, startServer } from '../helpers.js';

let server;
test.beforeEach(async () => { server = await startServer(); });
test.afterEach(async () => { await server.close(); });

const FULL_ACCOUNT_NUMBER = /\b\d{9,18}\b/;

test('protected routes require a session; login sets a hardened cookie', async () => {
  const c = httpClient(server.base);
  assert.equal((await c.get('/api/accounts')).status, 401);
  assert.equal((await c.get('/api/dashboard')).status, 401);
  const bad = await c.login('tejas', 'wrong');
  assert.equal(bad.status, 401);
  assert.equal(bad.json.error.message, 'Incorrect username or password.');
  const unknown = await c.login('nobody', 'wrong');
  assert.equal(unknown.json.error.message, 'Incorrect username or password.', 'no username enumeration');
  const ok = await c.login();
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.ok(!JSON.stringify(ok.json).includes('password'));
  assert.equal((await c.get('/api/auth/me')).json.user.username, 'tejas');
  await c.post('/api/auth/logout');
  assert.equal((await c.get('/api/accounts')).status, 401, 'session revoked server-side');
});

test('passwords are stored as scrypt hashes', () => {
  const db = freshDb();
  for (const u of db.all('SELECT password_hash FROM users')) assert.match(u.password_hash, /^scrypt\$16384\$8\$1\$/);
});

test('account locks after repeated failed logins', async () => {
  const c = httpClient(server.base);
  for (let i = 0; i < 5; i += 1) await c.login('aisha', 'nope');
  const locked = await c.login('aisha', 'Northstar@2026');
  assert.equal(locked.status, 429);
});

test('CSRF: state-changing requests need the custom header and an allowed origin', async () => {
  const c = httpClient(server.base);
  await c.login();
  const noHeader = await fetch(`${server.base}/api/auth/logout`, { method: 'POST', headers: { Cookie: c.cookie } });
  assert.equal(noHeader.status, 403);
  const foreign = await c.post('/api/chat', { message: 'hi' }, { Origin: 'https://evil.example' });
  assert.equal(foreign.status, 403);
});

test('security headers and request ids are present; errors are safe', async () => {
  const c = httpClient(server.base);
  const r = await c.get('/api/health');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(r.headers.get('x-request-id'), /^req_[a-f0-9]{16}$/);
  assert.equal(r.headers.get('x-powered-by'), null);
  const malformed = await fetch(`${server.base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'northstar' }, body: '{bad json' });
  assert.equal(malformed.status, 400);
  assert.ok(!(await malformed.text()).includes('SyntaxError'));
});

test('dashboard returns derived figures and never a full account number', async () => {
  const c = httpClient(server.base);
  await c.login();
  const d = (await c.get('/api/dashboard')).json;
  assert.equal(d.accounts.length, 3);
  assert.equal(d.trend.length, 6);
  assert.ok(d.budgets.budgets.length >= 4);
  assert.ok(d.insights.duplicates.length === 1);
  for (const path of ['/api/dashboard', '/api/accounts', '/api/beneficiaries', '/api/cards', '/api/transactions?limit=100', '/api/bills', '/api/recurring']) {
    const body = (await c.get(path)).text;
    assert.ok(!FULL_ACCOUNT_NUMBER.test(body.replace(/"(paise|amount_paise)":\d+/g, '').replace(/[A-Z]{2,4}\d+/g, '')), `${path} leaks an account number`);
  }
});

test('transaction query validation', async () => {
  const c = httpClient(server.base);
  await c.login();
  assert.equal((await c.get('/api/transactions?category=crypto')).status, 400);
  assert.equal((await c.get('/api/transactions?limit=5000')).status, 400);
  assert.equal((await c.get('/api/transactions?startDate=2026-13-01')).status, 400);
  assert.equal((await c.get('/api/transactions?evil=1')).status, 400);
  const r = await c.get('/api/transactions?status=pending');
  assert.equal(r.json.total, 1);
});

test('authorization: one customer cannot read another customer\'s resources', async () => {
  const tejas = httpClient(server.base);
  const aisha = httpClient(server.base);
  await tejas.login();
  await aisha.login('aisha');
  const chat = await tejas.chat('Send 500 to Priya');
  const actionId = chat.blocks.find((b) => b.type === 'confirmation').action.id;
  const txn = server.db.get(`SELECT id FROM transactions WHERE user_id = 'usr_tejas' LIMIT 1`).id;
  assert.equal((await aisha.get(`/api/conversations/${chat.meta.conversationId}`)).status, 404);
  assert.equal((await aisha.get(`/api/actions/${actionId}`)).status, 404);
  assert.equal((await aisha.post(`/api/actions/${actionId}/confirm`)).status, 404);
  assert.equal((await aisha.get(`/api/transactions/${txn}`)).status, 404);
  const continued = await aisha.chat('hello', chat.meta.conversationId);
  assert.equal(continued.status, 404);
  assert.equal(server.db.get('SELECT status FROM pending_actions WHERE id = :id', { id: actionId }).status, 'pending');
});

test('end-to-end transfer over the API: chat → preview → confirm → receipt → replay is idempotent', async () => {
  const c = httpClient(server.base);
  await c.login();
  const before = balanceOf(server.db, 'acc_tejas_sav');
  const chat = await c.chat('Send ₹2,000 to Priya');
  assert.equal(chat.meta.mode, 'demo');
  const card = chat.blocks.find((b) => b.type === 'confirmation');
  assert.equal(card.action.preview.amount.formatted, '₹2,000.00');
  assert.equal(card.action.preview.to.name, 'Priya Nair');
  assert.equal(card.action.preview.simulated, true);
  assert.equal(balanceOf(server.db, 'acc_tejas_sav'), before, 'nothing moves before confirmation');

  const typedYes = await c.chat('yes confirm it', chat.meta.conversationId);
  assert.equal(typedYes.status, 200);
  assert.equal(balanceOf(server.db, 'acc_tejas_sav'), before, 'typing "yes" does not execute');

  const confirm = await c.post(`/api/actions/${card.action.id}/confirm`);
  assert.equal(confirm.status, 200);
  assert.equal(confirm.json.action.status, 'completed');
  assert.equal(confirm.json.message.blocks[0].type, 'receipt');
  assert.equal(balanceOf(server.db, 'acc_tejas_sav'), before - 200000);

  const replay = await c.post(`/api/actions/${card.action.id}/confirm`);
  assert.equal(replay.json.action.replayed, true);
  assert.equal(replay.json.action.result.reference, confirm.json.action.result.reference);
  assert.equal(balanceOf(server.db, 'acc_tejas_sav'), before - 200000);

  const conv = (await c.get(`/api/conversations/${chat.meta.conversationId}`)).json;
  const confirmationBlock = conv.messages.flatMap((m) => m.blocks).find((b) => b.type === 'confirmation');
  assert.equal(confirmationBlock.action.status, 'completed', 'history shows the live status');
  assert.ok(server.db.get(`SELECT 1 AS x FROM audit_logs WHERE event = 'transfer.executed' AND user_id = 'usr_tejas' AND request_id LIKE 'req_%'`));
});

test('ambiguous "Send ₹2,000 to Rahul" → choice → preview', async () => {
  const c = httpClient(server.base);
  await c.login();
  const first = await c.chat('Send ₹2,000 to Rahul');
  const choices = first.blocks.find((b) => b.type === 'choices');
  assert.equal(choices.options.length, 2);
  const pick = choices.options.find((o) => o.label.startsWith('Rahul Sharma'));
  const second = await c.chat(pick.message, first.meta.conversationId);
  const card = second.blocks.find((b) => b.type === 'confirmation');
  assert.equal(card.action.preview.to.name, 'Rahul Sharma');
  assert.equal(card.action.preview.amount.paise, 200000);
});

test('UI-initiated actions use the same validation; viewers are read-only', async () => {
  const c = httpClient(server.base);
  await c.login();
  const bad = await c.post('/api/actions', { type: 'transfer', params: { recipient: 'Priya', amount: 'lots' } });
  assert.equal(bad.status, 400);
  const insufficient = await c.post('/api/actions', { type: 'transfer', params: { recipient: 'Priya', amount: '99999999' } });
  assert.equal(insufficient.status, 400);
  const bill = await c.post('/api/actions', { type: 'bill_payment', params: { bill: 'jio' } });
  assert.equal(bill.status, 201);
  const benef = await c.post('/api/actions', { type: 'add_beneficiary', params: { name: 'Kiran Rao', accountNumber: '123456789012', confirmAccountNumber: '123456789012', ifsc: 'HDFC0001234' } });
  assert.equal(benef.status, 201);
  assert.equal(benef.json.action.preview.maskedAccount, '••9012');

  const viewer = httpClient(server.base);
  await viewer.login('meera');
  assert.equal((await viewer.post('/api/actions', { type: 'card_block', params: {} })).status, 403);
  assert.equal((await viewer.put('/api/budgets/food', { amount: '5000' })).status, 403);
  const chat = await viewer.chat('Send 100 to Priya');
  assert.match(chat.done.message.content, /read-only/);
  assert.equal((await viewer.get('/api/accounts')).status, 200);
});

test('sensitive details typed into chat are masked before storage or processing', async () => {
  const c = httpClient(server.base);
  await c.login();
  const r = await c.chat('my otp is 482913 and card 4111 1111 1111 1111');
  assert.ok(r.blocks.some((b) => b.type === 'notice' && /masked/.test(b.message)));
  const stored = server.db.get(`SELECT content FROM messages WHERE role = 'user' ORDER BY rowid DESC LIMIT 1`).content;
  assert.ok(!stored.includes('482913'));
  assert.ok(!stored.includes('4111 1111 1111 1111'));
});

test('chat input validation and rate limiting', async () => {
  const c = httpClient(server.base);
  await c.login();
  assert.equal((await c.post('/api/chat', { message: '' })).status, 400);
  assert.equal((await c.post('/api/chat', { message: 'x'.repeat(2001) })).status, 400);
  assert.equal((await c.post('/api/chat', { message: 'hi', userId: 'usr_aisha' })).status, 400, 'client cannot pass identity');
  let last;
  for (let i = 0; i < 20; i += 1) last = await c.post('/api/chat', { message: '' });
  assert.equal(last.status, 429);
});

test('conversation history persists and can be deleted', async () => {
  const c = httpClient(server.base);
  await c.login();
  const a = await c.chat("What's my balance?");
  await c.chat('Show my last 5 transactions', a.meta.conversationId);
  const list = (await c.get('/api/conversations')).json.items;
  assert.equal(list[0].id, a.meta.conversationId);
  const conv = (await c.get(`/api/conversations/${a.meta.conversationId}`)).json;
  assert.equal(conv.messages.length, 4);
  assert.equal(conv.messages[1].blocks[0].type, 'accounts');
  assert.equal((await c.del(`/api/conversations/${a.meta.conversationId}`)).status, 200);
  assert.equal((await c.get(`/api/conversations/${a.meta.conversationId}`)).status, 404);
});

test('Gemini failures surface as a clean SSE error event (mocked client)', async () => {
  await server.close();
  server = await startServer({ llm: llmFor(fakeGemini([{ error: Object.assign(new Error('UNAVAILABLE'), { status: 503 }) }]), { maxRetries: 1 }) });
  const c = httpClient(server.base);
  await c.login();
  const r = await c.chat('hi');
  assert.equal(r.meta.mode, 'gemini');
  const err = r.events.find((e) => e.event === 'error');
  assert.equal(err.data.kind, 'overloaded');
  assert.match(r.done.message.content, /temporarily unavailable/);
});

test('GET /auth/me?include=dashboard returns session and dashboard together; signed out stays 200 with no data', async () => {
  const c = httpClient(server.base);
  const anon = await c.get('/api/auth/me?include=dashboard');
  assert.equal(anon.status, 200);
  assert.deepEqual(anon.json, { user: null });
  await c.login();
  const both = await c.get('/api/auth/me?include=dashboard');
  assert.equal(both.json.user.username, 'tejas');
  assert.equal(both.json.dashboard.accounts.length, 3);
  assert.deepEqual(both.json.dashboard.totalBalance, (await c.get('/api/dashboard')).json.totalBalance);
  assert.equal((await c.get('/api/auth/me')).json.dashboard, undefined, 'only when asked for');
});
