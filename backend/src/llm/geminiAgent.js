/**
 * @file backend/src/llm/geminiAgent.js
 * @description Google Gemini LLM agent adapter using the official `@google/genai` SDK.
 * Implements a multi-turn function-calling loop with `gemini-3.8-flash`. Injects system security
 * instructions, registers function declarations, dispatches requested tool calls to the tool
 * registry, collects tool responses or drafts pending sensitive actions, and streams/returns the final reply.
 */

import '../config.js';
import { GoogleGenAI } from '@google/genai';
import { getGeminiTools, validateAndRunTool } from '../tools/bankingTools.js';

const systemPrompt = `You are a careful banking assistant for a MOCK demo account. The authenticated user is Tejas.

Rules:
- Use the provided tools for account data. Never invent balances or transactions.
- Do not ask for or expose passwords, PINs, OTPs, or full account/card numbers.
- For spending questions, use get_spending_summary. Infer a category only when clear.
- For recent transaction questions, use get_transactions. For merchant/category/date filters, use search_transactions.
- For transfers and card blocking, call the relevant tool only to prepare a pending action. The backend will NOT execute it. Tell the user they must review and press the explicit confirmation button.
- Never claim a sensitive action is complete until the backend returns a successful confirmation result.
- Keep responses brief and clear. Currency is INR (₹).`;

const client = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;

export function isLiveLLMEnabled() {
  return Boolean(client);
}

export async function runGeminiAgent(history) {
  if (!client) throw new Error('Gemini is not configured.');

  const contents = history.map(({ role, content }) => ({
    role: role === 'assistant' ? 'model' : 'user',
    parts: [{ text: content }]
  }));

  const toolResults = [];
  const pending = [];
  const tools = getGeminiTools();
  let model = process.env.GEMINI_MODEL?.trim().replace(/^['"]|['"]$/g, '');
  if (!model || model.includes('2.5-flash')) {
    model = 'gemini-3.8-flash';
  }

  for (let step = 0; step < 4; step += 1) {
    const response = await client.models.generateContent({
      model,
      contents,
      config: {
        systemInstruction: systemPrompt,
        tools: [{ functionDeclarations: tools }],
        temperature: 0.2
      }
    });

    const calls = response.functionCalls || [];
    if (!calls.length) {
      return { text: response.text || 'I could not produce a response.', pending, toolResults };
    }

    contents.push(response.candidates[0].content);
    const functionResponses = [];

    for (const call of calls) {
      let output;
      try {
        const result = validateAndRunTool(call.name, call.args || {});
        if (result.kind === 'pending') {
          const confirmation = result.action;
          pending.push(confirmation);
          output = { status: 'awaiting_user_confirmation', action: confirmation };
        } else {
          output = { status: 'success', data: result.data };
        }
      } catch (error) {
        output = { status: 'error', message: error.message };
      }

      toolResults.push({ name: call.name, output });
      functionResponses.push({
        name: call.name,
        response: { result: output },
        ...(call.id ? { id: call.id } : {})
      });
    }

    contents.push({
      role: 'user',
      parts: functionResponses.map((functionResponse) => ({ functionResponse }))
    });
  }

  return {
    text: pending.length
      ? 'Please review the pending action below and confirm it explicitly to continue.'
      : 'I could not complete that request in this turn. Please try again.',
    pending,
    toolResults
  };
}
