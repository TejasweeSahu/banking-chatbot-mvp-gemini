/**
 * @file backend/src/index.js
 * @description Entry point for the banking chatbot backend server.
 * Loads environment configurations, binds the Express application to the designated port,
 * and logs the operating mode (Google Gemini live LLM tool calling vs. local demo agent).
 */

import './config.js';
import { app } from './app.js';

const port = Number(process.env.PORT || 4000);
app.listen(port, () => {
  console.log(`Banking chatbot API listening on http://localhost:${port}`);
  const modelName = process.env.GEMINI_MODEL?.includes('2.5-flash') ? 'gemini-3.8-flash' : (process.env.GEMINI_MODEL || 'gemini-3.8-flash');
  console.log(process.env.GEMINI_API_KEY ? `LLM mode: Gemini tool calling (${modelName})` : 'LLM mode: local demo agent (set GEMINI_API_KEY for live tool calling)');
});
