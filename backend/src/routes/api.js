/**
 * REST + streaming API. Every route below `requireAuth` derives identity from
 * the session; no route accepts a user id from the client.
 */

import { Router } from 'express';
import { z } from 'zod';
import { badRequest, conflict } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { csrfProtection, maskSensitiveInput, parseCookies, rateLimit, requireAuth, SESSION_COOKIE, sessionCookieOptions } from '../middleware/index.js';
import * as auth from '../services/authService.js';
import { listAccounts } from '../services/accountService.js';
import { getDashboard } from '../services/dashboardService.js';
import { explainTransaction, searchTransactions } from '../services/transactionService.js';
import { listBeneficiaries, prepareAddBeneficiary } from '../services/beneficiaryService.js';
import { listCards } from '../services/cardService.js';
import { listBills } from '../services/billService.js';
import { listRecurringPayments, listUpcomingPayments } from '../services/recurringService.js';
import { listBudgets, setBudget } from '../services/budgetService.js';
import { getComplaint, listComplaints } from '../services/supportService.js';
import { assertActionScope, cancelAction, confirmAction, createPendingAction, getAction, listPendingActions } from '../services/actionService.js';
import { appendMessage, createConversation, deleteConversation, getConversation, getConversationRow, listConversations } from '../services/conversationService.js';
import { runAssistantTurn } from '../llm/orchestrator.js';
import { executeTool } from '../tools/executor.js';
import { ALL_CATEGORIES, EXPENSE_CATEGORIES, amount, checkRange, dateRangeShape } from '../tools/schemas.js';
import { hasScope } from '../services/authService.js';
import { forbidden } from '../lib/errors.js';
import { today } from '../lib/dates.js';
import { config } from '../config.js';

const idParam = (prefix) => z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9_-]{4,40}$`), 'invalid id');

function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw badRequest('Invalid request.', result.error.issues.slice(0, 5).map((i) => ({ field: i.path.join('.'), problem: i.message })));
  }
  return result.data;
}

const requireScope = (scope) => (req, _res, next) => (hasScope(req.user, scope) ? next() : next(forbidden('Your profile has read-only access, so this action is not allowed.')));

export function createApiRouter({ db, llm }) {
  const router = Router();
  const authed = requireAuth(db);
  const activeTurns = new Set();

  router.get('/health', (_req, res) => res.json({ status: 'ok', db: Boolean(db.get('SELECT 1 AS ok')) }));
  router.get('/meta', (_req, res) => res.json({ assistantMode: llm?.client ? 'gemini' : 'demo', model: llm?.client ? llm.model : null, simulated: true, today: today() }));

  router.use(csrfProtection());

  // ---------- Auth ----------
  const loginLimiter = rateLimit({ name: 'login', windowMs: 60_000, max: config.loginRateLimitPerMin, key: (req) => req.ip });
  router.post('/auth/login', loginLimiter, (req, res) => {
    const body = parse(z.strictObject({ username: z.string().trim().min(1).max(40), password: z.string().min(1).max(128) }), req.body);
    const { token, user } = auth.login(db, { ...body, ip: req.ip, userAgent: req.get('user-agent') });
    res.cookie(SESSION_COOKIE, token, sessionCookieOptions());
    res.json({ user });
  });
  router.post('/auth/logout', authed, (req, res) => {
    auth.logout(db, req.user);
    res.clearCookie(SESSION_COOKIE, { ...sessionCookieOptions(), maxAge: undefined });
    res.json({ ok: true });
  });
  // Returns { user: null } rather than 401 so the app can check for a session without console noise.
  // ?include=dashboard returns the dashboard in the same response, removing a round trip from first load.
  router.get('/auth/me', (req, res) => {
    const user = auth.authenticate(db, parseCookies(req.get('cookie'))[SESSION_COOKIE]);
    const includeDashboard = req.query.include === 'dashboard' && user && hasScope(user, 'accounts:read');
    res.json({ user, ...(includeDashboard ? { dashboard: getDashboard(db, user) } : {}) });
  });

  router.use(authed);
  router.use(rateLimit({ name: 'api', windowMs: 60_000, max: 240 }));

  // ---------- Read APIs ----------
  router.get('/dashboard', (req, res) => res.json(getDashboard(db, req.user)));
  router.get('/accounts', (req, res) => res.json(listAccounts(db, req.user.id)));

  const txnQuery = z.strictObject({
    q: z.string().trim().max(60).optional(),
    category: z.enum(ALL_CATEGORIES).optional(),
    status: z.enum(['success', 'pending', 'failed']).optional(),
    direction: z.enum(['debit', 'credit']).optional(),
    accountId: idParam('acc').optional(),
    ...dateRangeShape,
    sort: z.enum(['date_desc', 'date_asc', 'amount_desc', 'amount_asc']).optional(),
    minAmount: amount('min').optional(),
    maxAmount: amount('max').optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    offset: z.coerce.number().int().min(0).max(10_000).optional()
  }).superRefine(checkRange);
  router.get('/transactions', (req, res) => {
    const q = parse(txnQuery, Object.fromEntries(Object.entries(req.query).filter(([, v]) => v !== '')));
    res.json(searchTransactions(db, req.user.id, { ...q, query: q.q, minAmountPaise: q.minAmount, maxAmountPaise: q.maxAmount, limit: q.limit ?? 25 }));
  });
  router.get('/transactions/:id', (req, res) => res.json(explainTransaction(db, req.user.id, parse(z.string().max(40), req.params.id))));
  router.get('/beneficiaries', (req, res) => res.json({ items: listBeneficiaries(db, req.user.id) }));
  router.get('/cards', (req, res) => res.json({ items: listCards(db, req.user.id) }));
  router.get('/bills', (req, res) => res.json({ items: listBills(db, req.user.id) }));
  router.get('/recurring', (req, res) => res.json({ ...listRecurringPayments(db, req.user.id), upcoming: listUpcomingPayments(db, req.user.id) }));
  router.get('/budgets', (req, res) => res.json(listBudgets(db, req.user.id)));
  router.put('/budgets/:category', requireScope('budgets:write'), (req, res) => {
    const category = parse(z.enum(EXPENSE_CATEGORIES), req.params.category);
    const body = parse(z.strictObject({ amount: amount('limit', { maxRupees: 1_000_000 }) }), req.body);
    res.json(setBudget(db, req.user.id, { category, amountPaise: body.amount }));
  });
  router.get('/complaints', (req, res) => res.json({ items: listComplaints(db, req.user.id) }));
  router.get('/complaints/:ref', (req, res) => res.json(getComplaint(db, req.user.id, parse(z.string().max(40), req.params.ref))));

  // ---------- Actions (prepare → confirm/cancel) ----------
  const prepareBody = z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('transfer'), params: z.record(z.string(), z.unknown()) }),
    z.strictObject({ type: z.literal('bill_payment'), params: z.record(z.string(), z.unknown()) }),
    z.strictObject({ type: z.literal('card_block'), params: z.record(z.string(), z.unknown()) }),
    z.strictObject({ type: z.literal('card_unblock'), params: z.record(z.string(), z.unknown()) }),
    z.strictObject({
      type: z.literal('add_beneficiary'),
      params: z.strictObject({
        name: z.string().max(60), nickname: z.string().max(30).optional(), accountNumber: z.string().max(24), confirmAccountNumber: z.string().max(24),
        ifsc: z.string().max(11), vpa: z.string().max(100).optional()
      })
    })
  ]);
  const prepareTool = { transfer: 'prepare_transfer', bill_payment: 'prepare_bill_payment', card_block: 'prepare_card_block', card_unblock: 'prepare_card_unblock' };
  router.get('/actions', (req, res) => res.json({ items: listPendingActions(db, req.user.id) }));
  router.post('/actions', (req, res) => {
    const body = parse(prepareBody, req.body);
    assertActionScope(req.user, body.type);
    if (body.type === 'add_beneficiary') {
      const result = prepareAddBeneficiary(db, req.user.id, body.params);
      if (result.status !== 'ready') return res.status(422).json({ status: result.status, error: { code: result.code ?? 'needs_input', message: result.message } });
      const action = createPendingAction(db, req.user, { type: 'add_beneficiary', payload: result.payload, preview: result.preview });
      return res.status(201).json({ status: 'awaiting_confirmation', action });
    }
    // Same tool path as the assistant, so validation and rules are identical.
    const env = executeTool({ db, user: req.user, conversationId: null }, prepareTool[body.type], body.params);
    if (env.status === 'awaiting_confirmation') return res.status(201).json({ status: env.status, action: env.blocks[0].action });
    const code = env.status === 'error' ? (env.data.code === 'forbidden' ? 403 : 400) : 422;
    return res.status(code).json({ status: env.status, error: { code: env.data.code ?? env.status, message: env.data.message, details: env.data.issues ?? env.data.options } });
  });
  router.get('/actions/:id', (req, res) => res.json(getAction(db, req.user.id, parse(idParam('act'), req.params.id))));

  const confirmLimiter = rateLimit({ name: 'confirm', windowMs: 60_000, max: 20 });
  router.post('/actions/:id/confirm', confirmLimiter, (req, res) => {
    const id = parse(idParam('act'), req.params.id);
    const result = confirmAction(db, req.user, id);
    const row = db.get('SELECT conversation_id FROM pending_actions WHERE id = :id', { id });
    let message = null;
    if (row?.conversation_id && !result.replayed) {
      const content = result.result?.message ?? 'Done.';
      const saved = appendMessage(db, row.conversation_id, {
        role: 'assistant', content, blocks: [{ type: 'receipt', action: result }],
        modelContext: `[User confirmed ${result.type} request ${result.id} via the Confirm button. Completed. ${result.result?.reference ? `Reference ${result.result.reference}.` : ''}]`
      });
      message = { id: saved.id, role: 'assistant', content, blocks: [{ type: 'receipt', action: result }], createdAt: saved.createdAt };
    }
    res.json({ action: result, message });
  });
  router.post('/actions/:id/cancel', (req, res) => {
    const id = parse(idParam('act'), req.params.id);
    const result = cancelAction(db, req.user, id);
    const row = db.get('SELECT conversation_id FROM pending_actions WHERE id = :id', { id });
    if (row?.conversation_id) appendMessage(db, row.conversation_id, { role: 'assistant', content: 'Request cancelled. Nothing was changed.', modelContext: `[User cancelled ${result.type} request ${result.id}. Not executed.]` });
    res.json({ action: result });
  });

  // ---------- Conversations & chat ----------
  router.get('/conversations', (req, res) => res.json({ items: listConversations(db, req.user.id) }));
  router.get('/conversations/:id', (req, res) => {
    const conversation = getConversation(db, req.user.id, parse(idParam('cnv'), req.params.id));
    // Confirmation cards reflect the action's current state, not the state when first shown.
    for (const m of conversation.messages) {
      m.blocks = m.blocks.map((b) => {
        if (b.type !== 'confirmation') return b;
        try { return { ...b, action: getAction(db, req.user.id, b.action.id) }; } catch { return b; }
      });
    }
    res.json(conversation);
  });
  router.delete('/conversations/:id', (req, res) => {
    deleteConversation(db, req.user.id, parse(idParam('cnv'), req.params.id));
    res.json({ ok: true });
  });

  const chatLimiter = rateLimit({ name: 'chat', windowMs: 60_000, max: 20 });
  const chatBody = z.strictObject({ conversationId: idParam('cnv').optional(), message: z.string().trim().min(1, 'Message is empty.').max(2000, 'Message is too long (2,000 characters max).') });
  router.post('/chat', chatLimiter, async (req, res) => {
    const body = parse(chatBody, req.body);
    const conversation = body.conversationId ? getConversationRow(db, req.user.id, body.conversationId) : createConversation(db, req.user.id, body.message);
    if (activeTurns.has(conversation.id)) throw conflict('Please wait for the current reply to finish.');
    activeTurns.add(conversation.id);
    const controller = new AbortController();
    const send = (event, data) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    let heartbeat;

    try {
      const cleaned = body.message.replace(/[\u0000-\u0008\u000b-\u001f\u007f‪-‮]/g, '');
      const { text, masked } = maskSensitiveInput(cleaned);
      const userMsg = appendMessage(db, conversation.id, { role: 'user', content: text });

      res.status(200).set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.flushHeaders();
      res.on('close', () => { if (!res.writableEnded) controller.abort(); });
      heartbeat = setInterval(() => { if (!res.writableEnded) res.write(': keep-alive\n\n'); }, 15_000);

      send('meta', { conversationId: conversation.id, title: conversation.title, userMessageId: userMsg.id, mode: llm?.client ? 'gemini' : 'demo' });
      if (masked) send('block', { type: 'notice', tone: 'warning', title: 'Sensitive details hidden', message: 'It looks like you shared a number, PIN, OTP or password. We masked it before processing. Never share these with anyone, including this assistant.' });
      const message = await runAssistantTurn({ db, user: req.user, conversationId: conversation.id, message: text, llm, emit: send, signal: controller.signal });
      send('done', { message });
    } catch (error) {
      logger.error('chat_stream_failed', { error });
      send('error', { kind: 'internal', message: 'Something went wrong. Please try again.' });
    } finally {
      clearInterval(heartbeat);
      activeTurns.delete(conversation.id);
      res.end();
    }
  });

  return router;
}
