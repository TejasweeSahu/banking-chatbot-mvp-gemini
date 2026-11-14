/**
 * Conversation sessions stored server-side. The client sends only the new
 * message; history comes from the database, so it cannot be tampered with.
 */

import { notFound } from '../lib/errors.js';
import { cleanText, newId } from './common.js';

export function listConversations(db, userId) {
  return db.all(`SELECT c.id, c.title, c.created_at AS createdAt, c.updated_at AS updatedAt,
                 (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS messageCount
                 FROM conversations c WHERE c.user_id = :userId ORDER BY c.updated_at DESC LIMIT 50`, { userId });
}

export function getConversationRow(db, userId, conversationId) {
  const row = db.get('SELECT * FROM conversations WHERE id = :conversationId AND user_id = :userId', { conversationId, userId });
  if (!row) throw notFound('Conversation not found.');
  return row;
}

export function getConversation(db, userId, conversationId) {
  const c = getConversationRow(db, userId, conversationId);
  const messages = db.all('SELECT id, role, content, blocks_json, tools_json, created_at FROM messages WHERE conversation_id = :id ORDER BY created_at, rowid', { id: c.id })
    .map((m) => ({ id: m.id, role: m.role, content: m.content, blocks: JSON.parse(m.blocks_json), tools: JSON.parse(m.tools_json), createdAt: m.created_at }));
  return { id: c.id, title: c.title, createdAt: c.created_at, updatedAt: c.updated_at, messages };
}

export function createConversation(db, userId, firstMessage) {
  const id = newId('cnv');
  const now = new Date().toISOString();
  const title = cleanText(firstMessage, 60) || 'New conversation';
  db.run('INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES (:id, :userId, :title, :now, :now)', { id, userId, title, now });
  return getConversationRow(db, userId, id);
}

export function deleteConversation(db, userId, conversationId) {
  getConversationRow(db, userId, conversationId);
  db.run('DELETE FROM messages WHERE conversation_id = :id', { id: conversationId });
  db.run('DELETE FROM conversations WHERE id = :id', { id: conversationId });
}

export function appendMessage(db, conversationId, { role, content, blocks = [], tools = [], modelContext = null }) {
  const id = newId('msg');
  const now = new Date().toISOString();
  db.run(`INSERT INTO messages (id, conversation_id, role, content, blocks_json, model_context, tools_json, created_at)
          VALUES (:id, :conversationId, :role, :content, :blocks, :modelContext, :tools, :now)`,
  { id, conversationId, role, content, blocks: JSON.stringify(blocks), modelContext, tools: JSON.stringify(tools), now });
  db.run('UPDATE conversations SET updated_at = :now WHERE id = :conversationId', { now, conversationId });
  return { id, createdAt: now };
}

/**
 * Context-window-aware history: newest turns first until the character budget
 * is spent, then restored to chronological order. Assistant turns carry a
 * compact note of the records they showed so follow-ups ("explain the second one")
 * can be resolved without replaying full tool payloads.
 */
export function buildModelHistory(db, conversationId, { maxMessages = 24, maxChars = 24_000 } = {}) {
  const rows = db.all('SELECT role, content, model_context FROM messages WHERE conversation_id = :id ORDER BY created_at DESC, rowid DESC LIMIT :limit', { id: conversationId, limit: maxMessages });
  const picked = [];
  let used = 0;
  for (const r of rows) {
    const text = r.role === 'assistant' && r.model_context ? `${r.content}\n\n${r.model_context}` : r.content;
    if (used + text.length > maxChars && picked.length) break;
    used += text.length;
    picked.push({ role: r.role, text });
  }
  picked.reverse();
  // Gemini expects the conversation to start with a user turn.
  while (picked.length && picked[0].role !== 'user') picked.shift();
  return picked;
}
