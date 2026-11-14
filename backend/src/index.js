/**
 * Server entry point: opens the database (seeding on first run), configures
 * Gemini when GEMINI_API_KEY is present, and starts the HTTP server.
 */

import { config } from './config.js';
import { createApp } from './app.js';
import { openDatabase } from './db/database.js';
import { isSeeded, seedDatabase } from './db/seed.js';
import { setToday, today } from './lib/dates.js';
import { createGeminiClient } from './llm/geminiClient.js';
import { logger } from './lib/logger.js';

if (config.demoAnchorDate) setToday(config.demoAnchorDate);

const db = openDatabase(config.databasePath);
if (config.seedOnStart && !isSeeded(db)) {
  seedDatabase(db, { anchor: today() });
  logger.info('database_seeded', { anchor: today() });
}

const client = createGeminiClient(config.gemini);
const llm = client ? { client, ...config.gemini, apiKey: undefined, state: { streamingUnavailable: config.gemini.streaming === 'off' } } : null;
const app = createApp({ db, llm });

const server = app.listen(config.port, () => {
  logger.info('server_started', {
    url: `http://localhost:${config.port}`,
    env: config.env,
    assistant: llm ? `gemini (${llm.model})` : 'demo agent (set GEMINI_API_KEY for Gemini)'
  });
});

function shutdown(signal) {
  logger.info('server_stopping', { signal });
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
