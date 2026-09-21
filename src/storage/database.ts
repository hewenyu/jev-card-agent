import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDatabase(filename: string): DatabaseSync {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  if (filename !== ':memory:') chmodSync(filename, 0o600);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, mode TEXT NOT NULL, strategy TEXT NOT NULL, model TEXT NOT NULL,
      status TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, reason TEXT, config TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id),
      hand_id TEXT, table_id TEXT, seq INTEGER, type TEXT NOT NULL,
      received_at TEXT NOT NULL, payload TEXT NOT NULL,
      UNIQUE(run_id, table_id, seq)
    );
    CREATE INDEX IF NOT EXISTS events_hand ON events(hand_id, id);
    CREATE TABLE IF NOT EXISTS hands (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), table_id TEXT NOT NULL,
      hand_number INTEGER NOT NULL, board TEXT NOT NULL, hero_cards TEXT NOT NULL,
      profit REAL, big_blind INTEGER NOT NULL, status TEXT NOT NULL,
      started_at TEXT NOT NULL, ended_at TEXT, complete INTEGER NOT NULL DEFAULT 0,
      initial_stack INTEGER, final_stack INTEGER
    );
    CREATE INDEX IF NOT EXISTS hands_run ON hands(run_id, started_at);
    CREATE INDEX IF NOT EXISTS hands_page ON hands(started_at DESC,id DESC);
    CREATE INDEX IF NOT EXISTS runs_page ON runs(started_at DESC,id DESC);
    CREATE TABLE IF NOT EXISTS decisions (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), hand_id TEXT NOT NULL,
      street TEXT NOT NULL, created_at TEXT NOT NULL, context TEXT NOT NULL,
      candidates TEXT NOT NULL, proposal TEXT NOT NULL, source TEXT NOT NULL,
      selected TEXT, status TEXT NOT NULL, latency_ms REAL NOT NULL, cost_usd REAL NOT NULL,
      fallback_reason TEXT, model TEXT
    );
    CREATE INDEX IF NOT EXISTS decisions_hand ON decisions(hand_id, created_at);
    CREATE TABLE IF NOT EXISTS actions (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), decision_id TEXT NOT NULL,
      table_id TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL,
      created_at TEXT NOT NULL, deadline_at INTEGER NOT NULL, details TEXT
    );
    CREATE TABLE IF NOT EXISTS usage (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, reserved_nanos INTEGER NOT NULL,
      charged_nanos INTEGER, input_tokens INTEGER, output_tokens INTEGER,
      status TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS evaluations (
      id TEXT PRIMARY KEY, created_at TEXT NOT NULL, result TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS leases (
      name TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', '1');
  `);
  return db;
}

export function json<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  return JSON.parse(value) as T;
}

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            !/^(authorization|api_?key|turn_?token|wallet_address|email|owner_id)$/i.test(key),
        )
        .map(([key, item]) => [key, redact(item)]),
    );
  }
  return value;
}
