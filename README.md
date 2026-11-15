# Northstar Bank: Gemini banking assistant

A full-stack demo of a digital bank in which **Gemini is the conversational layer and the backend owns the truth**. Balances, analytics, transfers and card changes all come from a validated service layer over a SQLite ledger. The model can request tools; it cannot read the database, do the arithmetic, or move money.

> All data is mock data. No real bank accounts, UPI networks or payment rails are connected. The UI labels every payment as **Simulated**.

## Quick start

Requires **Node.js 22.13+** (uses the built-in `node:sqlite`; tested on Node 26).

```bash
npm run install:all          # root + backend + frontend dependencies
cp .env.example .env         # then set GEMINI_API_KEY (optional, see below)
npm run dev                  # API on :4000, web app on http://localhost:5173
```

Sign in with **`tejas` / `Northstar@2026`**. Other demo profiles: `aisha` (a second customer, used for authorization tests) and `meera` (read-only).

| Command | What it does |
|---|---|
| `npm run dev` | Backend (watch mode) + Vite dev server with `/api` proxy |
| `npm start` | Builds the frontend and serves everything from Express on `:4000` (production mode, CSP, single origin) |
| `npm test` | Backend unit + integration tests (`node --test`, Gemini mocked) |
| `npm run test:e2e` | Playwright end-to-end tests against the production build in demo-agent mode (uses your installed Chrome) |
| `npm run test:all` | Both |
| `npm run db:reset` | Delete and re-seed the local database |

Without `GEMINI_API_KEY` the app runs a **deterministic demo agent** (a keyword router, not an LLM) over the same tool registry, so every workflow works offline. With a key, Gemini handles natural language, multi-turn context and tool selection.

## Architecture

### System overview

Every request passes through the same middleware. The model only reaches banking data through the tool registry, and money only moves through the action service after the user approves.

```mermaid
flowchart TB
    subgraph Browser["Browser: React + Vite"]
        UI["Dashboard · Transactions<br/>Payments · Cards · Help"]
        Chat["Assistant chat<br/>streaming text, cards, choices"]
        Confirm["Confirmation card<br/>Send money / Pay bill / Block card"]
    end

    subgraph API["Express API"]
        MW["Request ID · Helmet/CSP · CORS<br/>CSRF check · session auth<br/>rate limits · input masking"]
        REST["REST routes"]
        SSE["POST /api/chat<br/>Server-Sent Events"]
        Actions["POST /api/actions/:id/confirm"]
    end

    subgraph AI["Conversational layer"]
        Orch["Gemini orchestrator<br/>function calling · retries<br/>context budgeting"]
        Demo["Offline demo agent<br/>used when no API key"]
        Tools["Tool registry<br/>26 tools · Zod schemas<br/>scopes · execution log"]
    end

    Gemini[("Google Gemini API")]

    subgraph Core["Banking service layer"]
        Svc["Accounts · Transactions · Analytics<br/>Budgets · Recurring · Beneficiaries<br/>Transfers · Bills · Cards · Support"]
        ActionSvc["Action service<br/>pending → confirmed<br/>idempotent · 5 min expiry"]
        Audit["Audit log<br/>append-only"]
    end

    DB[("SQLite<br/>node:sqlite")]

    UI --> MW
    Chat --> MW
    Confirm --> MW
    MW --> REST & SSE & Actions
    SSE --> Orch
    SSE -.-> Demo
    Orch <-->|"function calls / results"| Gemini
    Orch --> Tools
    Demo --> Tools
    Tools -->|"read tools"| Svc
    Tools -->|"prepare_* tools"| ActionSvc
    REST --> Svc
    Actions -->|"user approval only"| ActionSvc
    ActionSvc --> Svc
    Svc --> Audit
    Svc --> DB
    ActionSvc --> DB
    Audit --> DB
```

### A chat turn

The orchestrator streams Gemini's output over Server-Sent Events. Tool results become UI cards built from verified data, and the model receives the exact formatted figures to explain.

```mermaid
sequenceDiagram
    autonumber
    actor U as User
    participant FE as React app
    participant API as Express /api/chat
    participant O as Orchestrator
    participant G as Gemini
    participant T as Tool registry
    participant S as Services + SQLite

    U->>FE: "Why did my expenses increase this month?"
    FE->>API: POST message + conversationId
    API->>API: Auth, CSRF, rate limit, mask PINs/OTPs
    API->>S: Save user message
    API-->>FE: SSE meta
    API->>O: Run turn with history from DB
    O->>G: generateContentStream with system prompt + tools
    G-->>O: functionCall compare_spending
    O-->>FE: SSE tool_start
    O->>T: Validate args with Zod, check scope
    T->>S: compareSpending, computed from the ledger
    S-->>T: Totals, category changes, drivers
    T-->>O: Envelope with data, UI block, context note
    O-->>FE: SSE block, rendered as a comparison card
    O->>G: functionResponse with exact formatted figures
    G-->>O: Streamed explanation text
    O-->>FE: SSE text deltas
    O->>S: Save assistant message, blocks, tool log
    O-->>FE: SSE done with suggested follow-ups

    Note over O,G: 429 / 5xx / network errors retry with backoff.<br/>A stream that never starts falls back to non-streaming.
```

### Transfer with clarification and confirmation

```mermaid
sequenceDiagram
    autonumber
    actor U as User
    participant FE as React app
    participant O as Orchestrator + Gemini
    participant T as prepare_transfer tool
    participant A as Action service
    participant S as Transfer service + SQLite

    U->>FE: "Send ₹2,000 to Rahul"
    FE->>O: Chat turn
    O->>T: recipient "Rahul", amount "2000"
    T->>S: Resolve beneficiary
    S-->>T: Two matches, Rahul Sharma and Rahul Verma
    T-->>FE: Choice buttons, nothing prepared
    U->>FE: Taps "Rahul Sharma — HDFC Bank ••4821"
    FE->>O: Chat turn with the chosen payee
    O->>T: recipient "Rahul Sharma ...", amount "2000"
    T->>S: Validate method, limits, available balance
    T->>A: Create pending action
    A-->>FE: Confirmation card with preview
    U->>FE: Types "yes"
    FE->>O: Chat turn
    O-->>FE: "Please use the Send money button", nothing executes
    U->>FE: Presses Send money
    FE->>A: POST /api/actions/:id/confirm
    A->>A: Owner? Pending? Not expired? Has scope?
    A->>S: Atomic transaction: re-check balance, debit, record transfer
    S-->>A: Receipt with reference NST…
    A-->>FE: Receipt card, balance updated
    FE->>A: Confirm again, e.g. a double click
    A-->>FE: Same receipt, marked replayed, no second debit
```

### Pending action lifecycle

```mermaid
stateDiagram-v2
    [*] --> pending: prepare_* tool or UI form, details validated
    pending --> pending: Identical request reuses the same action
    pending --> completed: User confirms, executed atomically
    pending --> cancelled: User cancels
    pending --> expired: After 5 minutes
    pending --> failed: Rule fails at execution, e.g. balance changed
    completed --> completed: Repeat confirm returns the stored receipt
    completed --> [*]
    cancelled --> [*]
    expired --> [*]
    failed --> [*]
```

### Data model (core tables)

```mermaid
erDiagram
    users ||--o{ sessions : has
    users ||--o{ accounts : owns
    users ||--o{ beneficiaries : saves
    users ||--o{ conversations : has
    users ||--o{ pending_actions : prepares
    users ||--o{ complaints : raises
    users ||--o{ budgets : sets
    accounts ||--o{ transactions : records
    accounts ||--o{ cards : "linked to"
    accounts ||--o{ recurring_payments : pays
    categories ||--o{ transactions : classifies
    categories ||--o{ budgets : limits
    transfers ||--o{ transactions : creates
    beneficiaries ||--o{ transfers : receives
    pending_actions ||--o| transfers : "executes as"
    billers ||--o{ bills : issues
    conversations ||--o{ messages : contains
    complaints ||--o{ complaint_events : tracks
    transactions |o--o{ complaints : "referenced by"

    users {
        text id PK
        text username UK
        text password_hash "scrypt"
        text role "customer or viewer"
    }
    accounts {
        text id PK
        text user_id FK
        text type "savings, current, fixed_deposit"
        int balance_paise "CHECK >= 0"
        int opening_balance_paise
    }
    transactions {
        text id PK
        text account_id FK
        text direction "debit or credit"
        int amount_paise "CHECK > 0"
        text status "success, pending, failed"
        text reference UK
    }
    transfers {
        text id PK
        text action_id UK "one transfer per action"
        int amount_paise
        text method "upi, imps, neft, rtgs, internal"
        text reference UK
    }
    pending_actions {
        text id PK
        text type
        text status
        text fingerprint "dedupes identical requests"
        text expires_at
    }
    audit_logs {
        int id PK
        text event
        text outcome
        text request_id "append-only via triggers"
    }
```

**Rules the architecture enforces**

- The model only sees 26 declared tools. None of them executes money movement: `prepare_*` tools create a **pending action**, and only `POST /api/actions/:id/confirm`, triggered by a button on the confirmation card, executes it. Typing "yes" does nothing.
- Identity comes from the session. No tool or route accepts a user ID; every query is scoped by `user_id`.
- Every tool argument goes through a strict Zod schema (unknown keys rejected), then through service-level business rules (ownership, limits, balance).
- All money is **integer paise**. Inputs are parsed from decimal strings (`"1,499.50"` → `149950`), so floats are never used for arithmetic. Responses carry `{ paise, value, formatted }` so neither the UI nor the model re-derives figures.
- UI cards (balances, transactions, charts, previews, receipts) are rendered from tool results, not from model text.

## Features

**Accounts:** multiple accounts (savings, family savings, fixed deposit), masked numbers, ledger vs **available** balance (pending payments are held).

**Transaction intelligence:** search by merchant/text/reference, category, status, direction, channel, amount range and date range, with sorting and pagination. Also: per-transaction explanations (status meaning, failure reason, merchant history, duplicate check, linked complaint), duplicate-charge detection, unusual-spending detection (large vs your category median, big first-time merchants, category spikes), and recurring/subscription detection.

**Conversational analytics (deterministic backend functions):** monthly spending with category breakdown, month-over-month comparison including a like-for-like "same days last month" window and the transactions driving the increase, largest transactions, a 6-month trend, budget progress with projections, and "how much can I safely save" with a full breakdown and stated assumptions.

**Fund transfers:** saved beneficiaries or own accounts. The workflow: understand → collect missing fields → disambiguate (e.g. two "Rahul"s become tappable choices) → validate method rules (UPI ≤ ₹1L with a UPI ID, IMPS ≤ ₹5L, NEFT, RTGS ≥ ₹2L), the daily limit (₹2L), and available balance → preview → explicit confirmation → atomic execution → reference number (`NST…`) → receipt.

**Duplicate-transfer protection:**
1. Preparing an identical request while one is pending reuses it.
2. Confirming is idempotent: a replay returns the stored receipt.
3. `transfers.action_id` is `UNIQUE`.
4. Debits use a guarded `UPDATE … WHERE balance >= amount`.
5. A recent identical transfer raises a duplicate warning on the preview.

Requests expire after 5 minutes.

**Bills, cards, beneficiaries:** pay due bills; block a card temporarily (reversible) or permanently (lost, stolen, suspicious, damaged); unblock. Payees are added through a form whose details never pass through the LLM.

**Support:** grounded help-centre answers (failed/pending UPI, refunds, duplicates, card blocking, disputes, limits, escalation, security), complaint registration (deduplicated per transaction) with SLA dates and a timeline, tracking, escalation with helpline and grievance contacts.

**Interface:** a dashboard (balance band, accounts, income vs spending chart with tooltip and table view, category bars, budgets, upcoming payments, insights, recent transactions), a streaming chat with step indicators, cards, tappable choices, follow-up suggestions, copy, stop/retry and saved conversation history, plus Transactions, Payments, Cards and Help pages. It is responsive (tab bar on mobile), has light and dark themes, keyboard focus, and respects reduced motion.

## Gemini integration

- Official `@google/genai` SDK; the key stays server-side; model set by `GEMINI_MODEL` (default `gemini-3.8-flash`).
- Function declarations are generated from the same Zod schemas used for validation (`parametersJsonSchema`, `additionalProperties: false`).
- Multi-step loop (max 6 steps, 10 tool calls per turn, 5 parallel calls per step). Model turns are replayed with their **thought signatures** intact; duplicate calls within a turn run once.
- **Streaming** over SSE (`GEMINI_STREAMING=auto`): if a stream fails before its first chunk, the process falls back to `generateContent`.
- **Retries** with exponential backoff and jitter for 429/5xx/network errors. The server's `retryDelay` is honoured, with at most one long wait. Timeouts (`GEMINI_TIMEOUT_MS`) are retried at most once. 401/400 are never retried. Users see safe, specific messages, including how long to wait when rate-limited.
- Malformed output (empty response, `MALFORMED_FUNCTION_CALL`, nameless calls, unknown tools, invalid arguments) is handled: unknown or invalid calls are returned to the model as structured errors.
- **Context window:** history is loaded from the database (the client only sends the new message), newest-first within a message and character budget. Assistant turns carry a compact note of the record IDs they showed, so "explain the second one" works without replaying full tool payloads.
- **Grounding guard:** amounts in a reply that don't appear in that turn's tool data are logged as `unverified_amounts_in_reply`.

## Security

- scrypt password hashing; login lockout (5 failures → 15 minutes); identical error for unknown user and wrong password; login rate limit.
- Opaque session tokens (only a SHA-256 is stored) in an `HttpOnly; SameSite=Strict` cookie scoped to `/api` (`Secure` in production), with absolute and idle expiry and server-side logout.
- CSRF: required `X-Requested-With` header plus an Origin allowlist. Helmet security headers and a strict CSP. CORS allowlist.
- Role scopes (`customer`, read-only `viewer`) checked per tool, per route and again at confirmation time.
- Rate limits on login, chat, confirmations and the general API.
- Strict validation at every boundary; 32 KB body limit; control and bidi characters stripped. Card numbers, account numbers, OTPs, PINs and passwords typed into chat are masked before storage or LLM processing.
- Prompt-injection defences: tool data is declared as untrusted, the model has no execution path, and confirmation is bound to an action ID owned by the session user.
- Structured JSON logs with request IDs and recursive redaction (secrets removed, account-like numbers masked). An append-only `audit_logs` table (DB triggers block UPDATE/DELETE) records logins, prepared/confirmed/denied/failed actions, transfers, bill payments, card changes, budgets and complaints. `tool_executions` logs every tool call with redacted arguments.
- Database constraints (CHECKs on amounts, statuses and balances ≥ 0, foreign keys, uniqueness) and `BEGIN IMMEDIATE` transaction boundaries.

## Environment variables

See [`.env.example`](.env.example). The ones you're most likely to set:

| Variable | Default | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | empty | Enables Gemini; empty runs the offline demo agent |
| `GEMINI_MODEL` | `gemini-3.8-flash` | Gemini model name |
| `GEMINI_TIMEOUT_MS` | `90000` | Per-request timeout |
| `GEMINI_STREAMING` | `auto` | `auto`, `on` or `off` |
| `PORT` | `4000` | API port |
| `DATABASE_PATH` | `backend/data/northstar.db` | SQLite file |
| `DEMO_ANCHOR_DATE` | today | Pins "today" so demo data and "this month" are reproducible |

## Tests

- **Backend: 82 tests** (`npm test`).
  - Money parsing and formatting, periods, the ledger invariant, balances and holds.
  - Search and filtering, spending versus independent SQL, month-over-month consistency, top transactions, duplicates, unusual spending, savings formula, budgets, recurring payments.
  - Beneficiary ambiguity; missing transfer parameters; insufficient balance; method and daily limits; confirmation; idempotent replay; deduped prepares; the DB unique constraint; cancel and expiry; cross-user and read-only denial; balance changing between preview and confirm.
  - Bills, cards and complaints.
  - Gemini orchestration with a scripted mock client: thought signatures; 429, 503, 401, timeouts, network errors and server `retryDelay`; the streaming fallback; empty, safety and malformed responses; hallucinated tools; invalid arguments; loop limits; context trimming.
  - HTTP: auth, cookies, lockout, CSRF, headers, authorization isolation, SSE transfer with confirm and replay, viewer restrictions, input masking, rate limits, history.
- **End-to-end: 21 Playwright tests** (`npm run test:e2e`), including axe-core accessibility checks (Lighthouse's agentic accessibility-tree rule set, in light and dark mode), a layout-shift budget, keyboard checks and discovery-file checks. Sign in and out; the ambiguous transfer, then approval, then an exact balance change; typed "yes" not executing plus cancel; analytics cards; history reopening; card block and unblock; bill payment; transaction filters and details; the read-only profile; mobile navigation without horizontal scroll.

The suite contains no LLM evaluation: Gemini is mocked so the tests are repeatable and free.

## Frontend performance and discoverability

- Measure with **`npm start`** (minified, code-split, Brotli pre-compressed), not `npm run dev`. The Vite dev server is never minified, so Lighthouse always reports about 1 MB of minification and unused-JS "savings" there.
- Only the dashboard ships in the initial bundle; other pages load on demand. React is a separate long-cached chunk.
- Fonts are self-hosted (DM Sans and Manrope, SIL OFL), subset with fontTools to the characters and weights the app uses (about 57 KB total), and preloaded; no third-party font requests.
- On the dashboard route, startup requests begin before React renders and `/api/auth/me?include=dashboard` returns the session and dashboard together, so the balance needs one API round trip.
- Run Lighthouse in an Incognito window (or with extensions disabled): browser extensions inject scripts that are counted against the page.
- `robots.txt` and `llms.txt` live in `frontend/public/`. There is deliberately no ARD manifest (`/.well-known/ard.json`): the app publishes no public agent resources, so `/.well-known/*` returns 404.

## Known limitations

- Mock data only. Transfers settle instantly inside the demo; there is no real NEFT batching, UPI PIN, OTP step-up or fraud scoring.
- Rate limiting and per-conversation turn locks are in-memory (single instance). Use Redis or the database for multi-instance deployments.
- SQLite suits a demo. A production system would use Postgres with row-level security, migrations tooling, and encryption of account numbers at rest.
- The demo agent understands a fixed set of phrasings; full natural language needs Gemini.
- Confirmation is a button click. Real banking would add step-up authentication (device binding, OTP or passkey) for high-value actions.
- The help centre is a small static article set searched by keywords, not a document retrieval system.
- Gemini model availability varies by key and region. During this build, `gemini-3.8-flash` was heavily overloaded for the configured key (multi-minute responses), while `gemini-3.5-flash` answered in about 10 s. Switch with `GEMINI_MODEL` if needed.
