/**
 * @file backend/src/routes/chat.js
 * @description Express router defining the core conversational and action confirmation endpoints:
 * - POST /chat: Validates user/assistant message payload history, invokes the agent (Gemini LLM
 *   or local fallback), registers any prepared sensitive actions in the pending store, and returns the response.
 * - POST /confirm: Validates confirmation tokens and executes or cancels pending sensitive banking actions
 *   (e.g., fund transfers or card blocks) with strict one-time execution and replay defense.
 */

import { Router } from 'express';
import { runDemoAgent } from '../llm/demoAgent.js';
import { isLiveLLMEnabled, runGeminiAgent } from '../llm/geminiAgent.js';
import { createPendingActions, resolvePendingAction } from '../services/confirmationService.js';

export const chatRouter = Router();
const HISTORY_LIMIT = 16;

function parseChatRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => key !== 'messages')) return null;
  if (!Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > HISTORY_LIMIT) return null;
  const valid = body.messages.every((message) => message && typeof message === 'object' && !Array.isArray(message)
    && Object.keys(message).every((key) => ['role', 'content'].includes(key))
    && ['user', 'assistant'].includes(message.role)
    && typeof message.content === 'string' && message.content.length <= 4000);
  return valid ? body.messages : null;
}

function parseConfirmRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (Object.keys(body).some((key) => !['confirmationId', 'approved'].includes(key))) return null;
  const isUuid = typeof body.confirmationId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.confirmationId);
  return isUuid && typeof body.approved === 'boolean' ? body : null;
}

chatRouter.post('/chat', async (req, res) => {
  const parsedMessages = parseChatRequest(req.body);
  if (!parsedMessages) {
    return res.status(400).json({ error: 'Invalid chat request. Send a list of user/assistant messages.' });
  }
  const history = parsedMessages.slice(-HISTORY_LIMIT);
  const latestUserMessage = [...history].reverse().find((message) => message.role === 'user');
  if (!latestUserMessage) return res.status(400).json({ error: 'A user message is required.' });

  try {
    const result = isLiveLLMEnabled()
      ? await runGeminiAgent(history)
      : runDemoAgent(latestUserMessage.content);
    const pending = createPendingActions(result.pending, req.mockUser.id);
    return res.json({
      reply: result.text,
      pending,
      mode: isLiveLLMEnabled() ? 'gemini' : 'demo',
      toolResults: result.toolResults ?? []
    });
  } catch (error) {
    console.error('Chat error:', error.message);
    return res.status(502).json({ error: 'The assistant could not process that request. Check the server configuration and try again.' });
  }
});

chatRouter.post('/confirm', (req, res) => {
  const parsed = parseConfirmRequest(req.body);
  if (!parsed) return res.status(400).json({ error: 'Invalid confirmation request.' });
  const { confirmationId, approved } = parsed;
  try {
    const result = resolvePendingAction({ confirmationId, approved, userId: req.mockUser.id });
    return res.json(result);
  } catch (error) {
    return res.status(error.statusCode || 400).json({ error: error.message });
  }
});
