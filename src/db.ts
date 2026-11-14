import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// auto_vacuum=INCREMENTAL only takes effect on a NEW file (or after VACUUM), so it is set before any table exists.
// Retention frees pages in batches and then calls incremental_vacuum, so the file shrinks without a long exclusive lock.
export function openDb(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("auto_vacuum = INCREMENTAL");
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");   // WAL + NORMAL: durable across app crash, may lose the last commits on power cut (history only; commands are re-derived)
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  return db;
}

export const SCHEMA = `
-- one row per (topic, sensor, metric); history rows reference it by integer id to keep the raw table small
CREATE TABLE IF NOT EXISTS series (
  id INTEGER PRIMARY KEY, topic TEXT NOT NULL, sensor_key TEXT NOT NULL, metric TEXT NOT NULL,
  UNIQUE (topic, sensor_key, metric));
CREATE TABLE IF NOT EXISTS latest (
  series_id INTEGER PRIMARY KEY REFERENCES series(id), value REAL NOT NULL, ts INTEGER NOT NULL);
-- raw history, 30 days. WITHOUT ROWID: the (series_id, ts) key IS the row, no second b-tree for the lookup.
CREATE TABLE IF NOT EXISTS history_raw (
  series_id INTEGER NOT NULL, ts INTEGER NOT NULL, value REAL NOT NULL,
  PRIMARY KEY (series_id, ts)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_history_raw_ts ON history_raw(ts);   -- retention scans by time
-- hourly rollup, kept after raw rows expire (tiny: 1 row per series per hour)
CREATE TABLE IF NOT EXISTS rollup_hourly (
  series_id INTEGER NOT NULL, hour_ts INTEGER NOT NULL, avg REAL NOT NULL, min REAL NOT NULL, max REAL NOT NULL, n INTEGER NOT NULL,
  PRIMARY KEY (series_id, hour_ts)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, pass_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('operator','admin')), active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS commands (
  id TEXT PRIMARY KEY, pump TEXT NOT NULL, action TEXT NOT NULL CHECK (action IN ('on','off')),
  status TEXT NOT NULL CHECK (status IN ('sent','confirmed','timeout')),
  username TEXT NOT NULL, role TEXT NOT NULL, created_at INTEGER NOT NULL, resolved_at INTEGER, note TEXT);
CREATE INDEX IF NOT EXISTS idx_commands_created ON commands(created_at);
-- append-only: who, what, when. Triggers refuse UPDATE and DELETE.
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, username TEXT NOT NULL, role TEXT NOT NULL, action TEXT NOT NULL, detail TEXT);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
`;

export type Db = Database.Database;

export function getSetting(db: Db, key: string, def: string): string {
  const r = db.prepare("SELECT value FROM settings WHERE key=?").get(key) as { value: string } | undefined;
  return r ? r.value : def;
}
export function setSetting(db: Db, key: string, value: string) {
  db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
}
export function audit(db: Db, username: string, role: string, action: string, detail: unknown) {
  db.prepare("INSERT INTO audit_log(ts,username,role,action,detail) VALUES(?,?,?,?,?)").run(Date.now(), username, role, action, JSON.stringify(detail));
}
