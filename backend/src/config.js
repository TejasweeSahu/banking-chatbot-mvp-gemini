/**
 * Loads and validates environment configuration once at startup.
 * Secrets (GEMINI_API_KEY) are read here and never leave the backend.
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

dotenv.config({ path: fileURLToPath(new URL('../../.env', import.meta.url)), quiet: true });

const stripQuotes = (value) => (typeof value === 'string' ? value.trim().replace(/^['"]|['"]$/g, '') : value);
const bool = (fallback) => z.preprocess((v) => (v === undefined || v === '' ? fallback : ['1', 'true', 'yes'].includes(String(v).toLowerCase())), z.boolean());

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  FRONTEND_ORIGIN: z.string().default('http://localhost:5173'),
  DATABASE_PATH: z.string().default(fileURLToPath(new URL('../data/northstar.db', import.meta.url))),
  SEED_ON_START: bool(true),
  DEMO_ANCHOR_DATE: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('').transform(() => undefined)),
  SESSION_TTL_MINUTES: z.coerce.number().int().min(5).max(24 * 60).default(480),
  SESSION_IDLE_MINUTES: z.coerce.number().int().min(1).max(24 * 60).default(30),
  TRUST_PROXY: bool(false),
  LOGIN_RATE_LIMIT_PER_MIN: z.coerce.number().int().min(1).max(10000).default(10),
  COOKIE_SECURE: z.preprocess((v) => (v === undefined || v === '' ? undefined : ['1', 'true', 'yes'].includes(String(v).toLowerCase())), z.boolean().optional()),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
  GEMINI_API_KEY: z.preprocess(stripQuotes, z.string().optional()),
  GEMINI_MODEL: z.preprocess(stripQuotes, z.string().min(1).default('gemini-3.8-flash')),
  GEMINI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300000).default(90000),
  GEMINI_MAX_RETRIES: z.coerce.number().int().min(0).max(6).default(3),
  GEMINI_STREAMING: z.preprocess((v) => (v === '' || v === undefined ? 'auto' : String(v).toLowerCase()), z.enum(['auto', 'on', 'off'])),
  GEMINI_THINKING_LEVEL: z.preprocess(stripQuotes, z.enum(['minimal', 'low', 'medium', 'high']).optional().or(z.literal('').transform(() => undefined))),
  GEMINI_TEMPERATURE: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().min(0).max(2).optional())
});

function load() {
  // Empty values (e.g. "DATABASE_PATH=" copied from .env.example) mean "use the default".
  const parsed = schema.safeParse(Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== '')));
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new Error(`Invalid environment configuration: ${fields}`);
  }
  const env = parsed.data;
  return {
    env: env.NODE_ENV,
    isProduction: env.NODE_ENV === 'production',
    port: env.PORT,
    frontendOrigins: env.FRONTEND_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean),
    databasePath: env.DATABASE_PATH,
    seedOnStart: env.SEED_ON_START,
    demoAnchorDate: env.DEMO_ANCHOR_DATE,
    sessionTtlMs: env.SESSION_TTL_MINUTES * 60_000,
    sessionIdleMs: env.SESSION_IDLE_MINUTES * 60_000,
    trustProxy: env.TRUST_PROXY,
    loginRateLimitPerMin: env.LOGIN_RATE_LIMIT_PER_MIN,
    cookieSecure: env.COOKIE_SECURE ?? env.NODE_ENV === 'production',
    logLevel: env.NODE_ENV === 'test' && !process.env.LOG_LEVEL ? 'silent' : env.LOG_LEVEL,
    gemini: {
      apiKey: env.GEMINI_API_KEY || undefined,
      model: env.GEMINI_MODEL,
      timeoutMs: env.GEMINI_TIMEOUT_MS,
      maxRetries: env.GEMINI_MAX_RETRIES,
      streaming: env.GEMINI_STREAMING,
      thinkingLevel: env.GEMINI_THINKING_LEVEL,
      temperature: env.GEMINI_TEMPERATURE
    }
  };
}

export const config = load();
