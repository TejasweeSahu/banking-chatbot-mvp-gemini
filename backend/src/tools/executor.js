/**
 * Executes a model-requested tool call safely:
 *   unknown tool → error · non-object / oversized args → error · scope check →
 *   strict schema validation → service call → structured envelope.
 * Every call is recorded in tool_executions (with redacted arguments).
 * Model-generated arguments are never trusted: the services re-validate
 * ownership and business rules on top of the schema.
 */

import { z } from 'zod';
import { TOOL_MAP, TOOLS } from './registry.js';
import { hasScope } from '../services/authService.js';
import { AppError } from '../lib/errors.js';
import { logger, redact, requestContext } from '../lib/logger.js';

const MAX_ARG_BYTES = 4000;

function stripNulls(value) {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => [k, stripNulls(v)]));
  }
  return value;
}

function logExecution(ctx, name, args, outcome, errorCode, startedAt) {
  try {
    ctx.db.run(`INSERT INTO tool_executions (user_id, conversation_id, request_id, tool, args_json, outcome, error_code, duration_ms, created_at)
                VALUES (:userId, :conversationId, :requestId, :tool, :args, :outcome, :errorCode, :duration, :now)`, {
      userId: ctx.user.id,
      conversationId: ctx.conversationId ?? null,
      requestId: requestContext.getStore()?.requestId ?? null,
      tool: String(name).slice(0, 64),
      args: JSON.stringify(redact(args ?? {})).slice(0, 2000),
      outcome,
      errorCode: errorCode ?? null,
      duration: Date.now() - startedAt,
      now: new Date().toISOString()
    });
  } catch (error) {
    logger.warn('tool_execution_log_failed', { error });
  }
}

export function executeTool(ctx, name, rawArgs) {
  const startedAt = Date.now();
  const tool = TOOL_MAP.get(name);
  const fail = (code, message, extra = {}) => {
    logExecution(ctx, name, rawArgs, 'error', code, startedAt);
    return { status: 'error', data: { code, message, ...extra }, blocks: [], durationMs: Date.now() - startedAt };
  };

  if (!tool) return fail('unknown_tool', `Tool "${String(name).slice(0, 64)}" does not exist. Use only the declared tools.`);
  if (rawArgs != null && (typeof rawArgs !== 'object' || Array.isArray(rawArgs))) return fail('invalid_arguments', 'Arguments must be a JSON object.');
  if (JSON.stringify(rawArgs ?? {}).length > MAX_ARG_BYTES) return fail('invalid_arguments', 'Arguments are too large.');
  if (!hasScope(ctx.user, tool.scope)) {
    logger.warn('tool_forbidden', { tool: name, role: ctx.user.role });
    return fail('forbidden', 'This profile has read-only access, so this operation is not permitted. Explain this to the user.');
  }

  const parsed = tool.schema.safeParse(stripNulls(rawArgs ?? {}));
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((i) => ({ field: i.path.join('.') || '(root)', problem: i.code === 'unrecognized_keys' ? `unknown field(s): ${i.keys.join(', ')}` : i.message }));
    return fail('invalid_arguments', 'The arguments did not pass validation. Fix them or ask the user for the missing/invalid detail.', { issues });
  }

  try {
    const envelope = tool.run(ctx, parsed.data);
    logExecution(ctx, name, parsed.data, envelope.status, null, startedAt);
    return { ...envelope, durationMs: Date.now() - startedAt };
  } catch (error) {
    if (error instanceof AppError) return fail(error.code, error.message);
    logger.error('tool_failed', { tool: name, error });
    return fail('service_error', 'The banking service could not complete this request. Apologise and suggest trying again later; do not guess any figures.');
  }
}

/**
 * Compact projection of tool data for the model: money objects become their
 * exact formatted string so the model quotes backend figures verbatim.
 */
export function toModelView(value, depth = 0) {
  if (depth > 8 || value == null) return value;
  if (Array.isArray(value)) return value.map((v) => toModelView(v, depth + 1));
  if (typeof value !== 'object') return value;
  if ('paise' in value && 'formatted' in value) return value.formatted;
  if ('label' in value && 'color' in value && 'id' in value && Object.keys(value).length === 3) return value.label;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === 'color' || k === 'postedAt' || v === null) continue;
    out[k] = toModelView(v, depth + 1);
  }
  return out;
}

/** Gemini function declarations generated from the same Zod schemas used for validation. */
export function getFunctionDeclarations() {
  return TOOLS.map((tool) => {
    const { $schema, ...schema } = z.toJSONSchema(tool.schema, { io: 'input', unrepresentable: 'any' });
    return { name: tool.name, description: tool.description, parametersJsonSchema: schema };
  });
}

export function toolLabel(name) {
  return TOOL_MAP.get(name)?.label ?? 'Working on it';
}
