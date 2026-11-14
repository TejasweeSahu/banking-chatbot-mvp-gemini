/**
 * @file backend/src/app.js
 * @description Configures the core Express application.
 * Sets up CORS, JSON body parsing, server-side mock identity injection middleware (to prevent
 * client identity spoofing), health check and demo-state endpoints, router mounts, and
 * global error handling.
 */

import express from 'express';
import cors from 'cors';
import { MOCK_USER } from './data/mockData.js';
import { chatRouter } from './routes/chat.js';
import { getBalance, getCardStatus } from './services/bankingService.js';

export const app = express();
app.use(cors({ origin: process.env.FRONTEND_ORIGIN || 'http://localhost:5173' }));
app.use(express.json({ limit: '100kb' }));

// Assessment-only mock identity. Never accept a user ID from the browser.
app.use((req, _res, next) => {
  req.mockUser = { id: MOCK_USER.id, name: MOCK_USER.name };
  next();
});

app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'banking-chatbot-api' }));
app.get('/api/demo-state', (_req, res) => res.json({ user: { name: MOCK_USER.name, accountLast4: MOCK_USER.accountLast4 }, balance: getBalance(), card: getCardStatus() }));
app.use('/api', chatRouter);

app.use((err, _req, res, _next) => {
  console.error('Unhandled API error:', err);
  res.status(500).json({ error: 'Unexpected server error.' });
});
