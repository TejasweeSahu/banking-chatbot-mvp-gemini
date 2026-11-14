/**
 * SQLite access via Node's built-in `node:sqlite` (no native add-ons).
 * Provides migrations and a re-entrant transaction helper; nested calls use
 * SAVEPOINTs so service functions can compose inside one atomic boundary.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MIGRATIONS } from './schema.js';

export function openDatabase(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  migrate(db);
  return wrap(db);
}

function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version));
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(migration.version, new Date().toISOString());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

function wrap(raw) {
  const statements = new Map();
  let depth = 0;
  const prepare = (sql) => {
    let stmt = statements.get(sql);
    if (!stmt) {
      stmt = raw.prepare(sql);
      statements.set(sql, stmt);
    }
    return stmt;
  };
  const plain = (row) => (row ? { ...row } : row);

  return {
    raw,
    get: (sql, params = {}) => plain(prepare(sql).get(params)),
    all: (sql, params = {}) => prepare(sql).all(params).map(plain),
    run: (sql, params = {}) => prepare(sql).run(params),
    exec: (sql) => raw.exec(sql),
    /** Run fn atomically. Re-entrant: inner calls become savepoints. */
    transaction(fn) {
      const name = `sp_${depth}`;
      raw.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${name}`);
      depth += 1;
      try {
        const result = fn();
        depth -= 1;
        raw.exec(depth === 0 ? 'COMMIT' : `RELEASE ${name}`);
        return result;
      } catch (error) {
        depth -= 1;
        raw.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${name}; RELEASE ${name}`);
        throw error;
      }
    },
    close: () => raw.close()
  };
}
