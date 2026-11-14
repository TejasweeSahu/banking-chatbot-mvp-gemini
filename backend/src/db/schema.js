/**
 * Relational schema. Money is INTEGER paise everywhere. CHECK constraints and
 * foreign keys enforce invariants at the storage layer as a second line of
 * defence behind service-layer validation.
 */

export const MIGRATIONS = [
  {
    version: 1,
    sql: `
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  full_name     TEXT NOT NULL,
  email         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('customer', 'viewer')),
  failed_logins INTEGER NOT NULL DEFAULT 0 CHECK (failed_logins >= 0),
  locked_until  TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  ip           TEXT,
  user_agent   TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE categories (
  id    TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  kind  TEXT NOT NULL CHECK (kind IN ('expense', 'income', 'transfer', 'investment')),
  color TEXT NOT NULL
);

CREATE TABLE accounts (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id),
  type              TEXT NOT NULL CHECK (type IN ('savings', 'current', 'fixed_deposit')),
  nickname          TEXT NOT NULL,
  account_number    TEXT NOT NULL UNIQUE,
  ifsc              TEXT NOT NULL,
  branch            TEXT NOT NULL,
  opening_balance_paise INTEGER NOT NULL CHECK (opening_balance_paise >= 0),
  balance_paise     INTEGER NOT NULL CHECK (balance_paise >= 0),
  currency          TEXT NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  status            TEXT NOT NULL CHECK (status IN ('active', 'frozen', 'closed')),
  is_primary        INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  interest_rate_bps INTEGER NOT NULL DEFAULT 0 CHECK (interest_rate_bps >= 0),
  opened_on         TEXT NOT NULL,
  maturity_date     TEXT
);
CREATE INDEX idx_accounts_user ON accounts(user_id);

CREATE TABLE beneficiaries (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id),
  name           TEXT NOT NULL,
  nickname       TEXT,
  bank_name      TEXT NOT NULL,
  account_number TEXT NOT NULL,
  ifsc           TEXT NOT NULL,
  vpa            TEXT,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  created_at     TEXT NOT NULL,
  UNIQUE (user_id, account_number, ifsc)
);
CREATE INDEX idx_beneficiaries_user ON beneficiaries(user_id);

CREATE TABLE transfers (
  id                   TEXT PRIMARY KEY,
  user_id              TEXT NOT NULL REFERENCES users(id),
  action_id            TEXT NOT NULL UNIQUE,
  from_account_id      TEXT NOT NULL REFERENCES accounts(id),
  beneficiary_id       TEXT REFERENCES beneficiaries(id),
  to_account_id        TEXT REFERENCES accounts(id),
  amount_paise         INTEGER NOT NULL CHECK (amount_paise > 0),
  method               TEXT NOT NULL CHECK (method IN ('upi', 'imps', 'neft', 'rtgs', 'internal')),
  note                 TEXT,
  status               TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
  reference            TEXT NOT NULL UNIQUE,
  debit_transaction_id TEXT,
  created_at           TEXT NOT NULL,
  CHECK ((beneficiary_id IS NULL) <> (to_account_id IS NULL)),
  CHECK (to_account_id IS NULL OR to_account_id <> from_account_id)
);
CREATE INDEX idx_transfers_user ON transfers(user_id, created_at);

CREATE TABLE transactions (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id),
  account_id          TEXT NOT NULL REFERENCES accounts(id),
  date                TEXT NOT NULL,
  posted_at           TEXT NOT NULL,
  description         TEXT NOT NULL,
  merchant            TEXT NOT NULL,
  category_id         TEXT NOT NULL REFERENCES categories(id),
  direction           TEXT NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount_paise        INTEGER NOT NULL CHECK (amount_paise > 0),
  status              TEXT NOT NULL CHECK (status IN ('success', 'pending', 'failed')),
  channel             TEXT NOT NULL CHECK (channel IN ('upi', 'card', 'neft', 'imps', 'rtgs', 'netbanking', 'auto_debit', 'atm', 'internal')),
  reference           TEXT NOT NULL UNIQUE,
  failure_reason      TEXT,
  transfer_id         TEXT REFERENCES transfers(id),
  created_at          TEXT NOT NULL
);
CREATE INDEX idx_txn_user_date ON transactions(user_id, date);
CREATE INDEX idx_txn_account_date ON transactions(account_id, date);
CREATE INDEX idx_txn_merchant ON transactions(user_id, merchant);

CREATE TABLE cards (
  id                    TEXT PRIMARY KEY,
  user_id               TEXT NOT NULL REFERENCES users(id),
  account_id            TEXT NOT NULL REFERENCES accounts(id),
  network               TEXT NOT NULL CHECK (network IN ('visa', 'mastercard', 'rupay')),
  variant               TEXT NOT NULL,
  last4                 TEXT NOT NULL CHECK (length(last4) = 4),
  expiry                TEXT NOT NULL,
  status                TEXT NOT NULL CHECK (status IN ('active', 'temporarily_blocked', 'blocked')),
  block_reason          TEXT,
  daily_limit_paise     INTEGER NOT NULL CHECK (daily_limit_paise > 0),
  online_enabled        INTEGER NOT NULL DEFAULT 1 CHECK (online_enabled IN (0, 1)),
  international_enabled INTEGER NOT NULL DEFAULT 0 CHECK (international_enabled IN (0, 1)),
  updated_at            TEXT NOT NULL
);

CREATE TABLE billers (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id),
  name            TEXT NOT NULL,
  category_id     TEXT NOT NULL REFERENCES categories(id),
  consumer_number TEXT NOT NULL,
  UNIQUE (user_id, name, consumer_number)
);

CREATE TABLE bills (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id),
  biller_id           TEXT NOT NULL REFERENCES billers(id),
  period_label        TEXT NOT NULL,
  amount_paise        INTEGER NOT NULL CHECK (amount_paise > 0),
  due_date            TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('due', 'paid')),
  paid_transaction_id TEXT REFERENCES transactions(id),
  UNIQUE (biller_id, period_label)
);

CREATE TABLE budgets (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id),
  category_id         TEXT NOT NULL REFERENCES categories(id),
  monthly_limit_paise INTEGER NOT NULL CHECK (monthly_limit_paise > 0),
  updated_at          TEXT NOT NULL,
  UNIQUE (user_id, category_id)
);

CREATE TABLE recurring_payments (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  account_id    TEXT NOT NULL REFERENCES accounts(id),
  name          TEXT NOT NULL,
  merchant      TEXT NOT NULL,
  category_id   TEXT NOT NULL REFERENCES categories(id),
  amount_paise  INTEGER NOT NULL CHECK (amount_paise > 0),
  frequency     TEXT NOT NULL CHECK (frequency IN ('monthly', 'quarterly', 'yearly')),
  kind          TEXT NOT NULL CHECK (kind IN ('subscription', 'standing_instruction', 'sip', 'autopay_bill', 'emi')),
  next_due_date TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('active', 'paused'))
);

CREATE TABLE complaints (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id),
  reference      TEXT NOT NULL UNIQUE,
  category       TEXT NOT NULL CHECK (category IN ('failed_upi', 'pending_payment', 'refund', 'duplicate_charge', 'card_issue', 'dispute', 'other')),
  transaction_id TEXT REFERENCES transactions(id),
  description    TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('open', 'in_progress', 'escalated', 'resolved', 'closed')),
  priority       TEXT NOT NULL CHECK (priority IN ('normal', 'high')),
  sla_due_date   TEXT NOT NULL,
  resolution     TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX idx_complaints_user ON complaints(user_id, created_at);

CREATE TABLE complaint_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  complaint_id TEXT NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
  status       TEXT NOT NULL,
  note         TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE TABLE conversations (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  title      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_conversations_user ON conversations(user_id, updated_at);

CREATE TABLE messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content         TEXT NOT NULL,
  blocks_json     TEXT NOT NULL DEFAULT '[]',
  model_context   TEXT,
  tools_json      TEXT NOT NULL DEFAULT '[]',
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at);

CREATE TABLE pending_actions (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id),
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  type            TEXT NOT NULL CHECK (type IN ('transfer', 'bill_payment', 'card_block', 'card_unblock', 'add_beneficiary')),
  payload_json    TEXT NOT NULL,
  preview_json    TEXT NOT NULL,
  fingerprint     TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'cancelled', 'expired', 'failed')),
  result_json     TEXT,
  error_message   TEXT,
  expires_at      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  resolved_at     TEXT
);
CREATE INDEX idx_actions_user ON pending_actions(user_id, status);

CREATE TABLE tool_executions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         TEXT NOT NULL,
  conversation_id TEXT,
  request_id      TEXT,
  tool            TEXT NOT NULL,
  args_json       TEXT NOT NULL,
  outcome         TEXT NOT NULL,
  error_code      TEXT,
  duration_ms     INTEGER NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE TABLE audit_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT,
  event         TEXT NOT NULL,
  resource_type TEXT,
  resource_id   TEXT,
  outcome       TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'denied')),
  details_json  TEXT NOT NULL DEFAULT '{}',
  request_id    TEXT,
  ip            TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_audit_user ON audit_logs(user_id, created_at);

-- Audit logs are append-only.
CREATE TRIGGER audit_logs_no_update BEFORE UPDATE ON audit_logs BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;
CREATE TRIGGER audit_logs_no_delete BEFORE DELETE ON audit_logs BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;
`
  }
];
