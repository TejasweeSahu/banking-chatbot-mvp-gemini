# Northstar Banking Chatbot MVP

A local banking-assistant demo with a React UI, Express API, mock banking service, and an LLM tool-calling adapter.

## Architecture

```text
React chat UI
   │  POST /api/chat
   ▼
Express API + mock user context
   │
   ├── Google Gemini tool-calling agent (when GEMINI_API_KEY is set)
   └── Local demo intent router (when no API key is set)
             │
             ▼
      Validated tool registry (Zod)
             │
      ┌──────┴──────────────────────┐
      │                             │
 Read-only mock banking calls   Sensitive action preparation
      │                             │
      ▼                             ▼
 Mock banking service          Pending confirmation store
                                    │
                          User presses Confirm / Cancel
                                    │
                           POST /api/confirm
                                    │
                                    ▼
                         Server executes validated action
```

The LLM can request tools but cannot mutate banking data. Every tool argument is validated by the backend. `transfer_money` and `block_card` only prepare a pending action. Actual mutation happens only in the separate confirmation endpoint after a user confirms in the UI.

## Requirements

- Node.js 20+ (tested with Node 22)
- npm
- Optional: Google Gemini API key for live LLM tool calling

## Run locally

From this folder:

```bash
npm run install:all
cp .env.example .env
# Optional: set GEMINI_API_KEY in .env to enable live LLM tool calling
npm run dev
```

Open **http://localhost:5173**. The API runs on **http://localhost:4000**.

Without an API key the app runs in local demo mode. It maps the assessment prompts to the same validated backend tools so all flows can be demonstrated without external credentials. With `GEMINI_API_KEY`, it switches to Google Gemini function calling (`gemini-3.8-flash` by default). Set `GEMINI_MODEL` to change the model.

## Demo prompts

- `What's my balance?`
- `Show my last 5 transactions`
- `How much did I spend on food this month?`
- `Transfer ₹5000 to Rahul` then press **Confirm transfer**
- `Block my card` then press **Confirm block**

## API routes

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/health` | Health check |
| GET | `/api/demo-state` | Mock account overview for the UI |
| POST | `/api/chat` | Assistant request and validated tool execution / preparation |
| POST | `/api/confirm` | Approve or cancel a pending sensitive action |

## Tools

- `get_balance`
- `get_transactions`
- `search_transactions`
- `get_spending_summary`
- `transfer_money` (prepare only, requires explicit confirmation)
- `block_card` (prepare only, requires explicit confirmation)

## Security boundaries in this MVP

- Mock user identity is injected by the Express server. The browser cannot choose a user ID.
- The LLM only receives the six declared tools. It does not receive a database connection or direct service mutation functions.
- Zod validates all tool arguments on the backend, with strict object schemas and bounded values.
- Sensitive tool calls create short-lived, one-time confirmation IDs tied to the mock user.
- The confirmation endpoint re-checks the action and executes it server-side. Replays and expired confirmations are rejected.
- No real authentication, database, payment rail, or banking API is included.

This is an assessment demo, not production banking software. A production system would also need real identity/session security, authorization scopes, CSRF protection, audit logs, rate limiting, fraud controls, secrets management, and transaction idempotency backed by durable storage.

## Suggested 1-hour assessment walkthrough

1. Start the app in demo mode and show the account overview.
2. Ask `What's my balance?` and point out the `get_balance` call.
3. Ask `Show my last 5 transactions` and point out the five returned records.
4. Ask `How much did I spend on food this month?` and show the category total.
5. Ask `Transfer ₹5000 to Rahul`. Explain that the tool creates a pending action only. Show the beneficiary, source account, and amount in the approval card.
6. Press **Confirm transfer**. The backend executes the transfer once, updates the mock balance to ₹53,250.75, and rejects a replay of the same confirmation ID.
7. Ask `Block my card`, then press **Confirm block**. The card changes to Blocked only after approval.

The seeded food transactions total **₹1,450** for November 2026. The seeded balance is **₹58,250.75** before the sample transfer.
