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
  db.exec(SCHEMA_M2);
  for (const [col, type] of [["clear_reason", "TEXT"], ["last_data_at", "INTEGER"]]) if (!(db.prepare("PRAGMA table_info(alarm_events)").all() as { name: string }[]).some((c) => c.name === col)) db.exec(`ALTER TABLE alarm_events ADD COLUMN ${col} ${type}`);   // dev copies that already had the first version of the table
  // 2026-11-16: slots are numbered 1..N everywhere (database, API, UI). Rows written by the first Milestone 2 build used the 0-based group index.
  // Two passes through negative numbers because the unique index (type, slot) is checked row by row.
  if (!db.prepare("SELECT 1 FROM settings WHERE key='slots_1based'").get()) db.transaction(() => {
    db.exec("UPDATE sensors SET slot = -slot - 1 WHERE slot IS NOT NULL; UPDATE sensors SET slot = -slot WHERE slot < 0; UPDATE sensors SET sent_slot = sent_slot + 1 WHERE sent_slot IS NOT NULL; UPDATE pending_removals SET slot = slot + 1 WHERE slot IS NOT NULL;");
    db.prepare("INSERT INTO settings(key,value) VALUES('slots_1based','1')").run();
  })();
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
CREATE TABLE IF NOT EXISTS login_fail (
  scope TEXT NOT NULL, key TEXT NOT NULL, n INTEGER NOT NULL, first_ts INTEGER NOT NULL, locked_until INTEGER NOT NULL, PRIMARY KEY (scope, key));
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

// Milestone 2 (C1 gateway). Readings still go to series/latest/history_raw/rollup_hourly, keyed by serial + metric:
// topic "gateway/<type>", sensor_key = serial, metric "temperature" (CALIBRATED) and "temperature_raw" (raw). Rollups, alarms and the SCADA View use the calibrated series.
export const SCHEMA_M2 = `
CREATE TABLE IF NOT EXISTS zones (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  type TEXT NOT NULL CHECK (type IN ('climate','soil','water_storage','irrigation','custom')), sort INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sensors (
  serial TEXT PRIMARY KEY, type TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', zone_id INTEGER REFERENCES zones(id) ON DELETE SET NULL,
  slot INTEGER, reporting_interval INTEGER NOT NULL, created_at INTEGER NOT NULL, replaced_by TEXT,
  thresholds TEXT,                                   -- JSON alarm thresholds, moved by Replace sensor
  sent_slot INTEGER, sent_interval INTEGER,          -- what the gateway is known to hold; differs from slot/reporting_interval = NOT SENT / CHANGED
  interval_changed_at INTEGER, interval_confirmed INTEGER NOT NULL DEFAULT 1,   -- "applying" until the observed update rate matches
  fp TEXT, last_change INTEGER);                     -- staleness: fingerprint of the last channel frame and when CORE last saw it change
CREATE UNIQUE INDEX IF NOT EXISTS idx_sensor_slot ON sensors(type, slot) WHERE slot IS NOT NULL AND replaced_by IS NULL;
-- sensors deleted in CORE whose group is still in the gateway: the next Send clears them. Their slot is NOT reused before that.
CREATE TABLE IF NOT EXISTS pending_removals (type TEXT NOT NULL, serial TEXT NOT NULL, slot INTEGER, PRIMARY KEY (type, serial));
CREATE TABLE IF NOT EXISTS points (id INTEGER PRIMARY KEY, zone_id INTEGER NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
  serial TEXT NOT NULL, metric TEXT NOT NULL, role TEXT NOT NULL, unit TEXT NOT NULL DEFAULT '', UNIQUE (zone_id, serial, metric));
CREATE TABLE IF NOT EXISTS calibrations (
  id INTEGER PRIMARY KEY, serial TEXT NOT NULL, metric TEXT NOT NULL, offset REAL NOT NULL, gain REAL NOT NULL DEFAULT 1,
  method TEXT NOT NULL CHECK (method IN ('offset','two_point','manual','reset')), notes TEXT, calibrated_at INTEGER NOT NULL, calibrated_by TEXT NOT NULL,
  due_at INTEGER, active INTEGER NOT NULL DEFAULT 1, check_sensor INTEGER NOT NULL DEFAULT 0);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cal_active ON calibrations(serial, metric) WHERE active=1;
CREATE TABLE IF NOT EXISTS gateway_state (id INTEGER PRIMARY KEY CHECK (id=1), online INTEGER NOT NULL DEFAULT 0, last_ok INTEGER, version INTEGER, address INTEGER, map_version INTEGER, last_error TEXT, updated_at INTEGER);
-- Alarm history: one row per alarm episode (raised -> cleared), with who acknowledged it. Written by AlarmTracker; the live alarm list itself is still computed on demand.
CREATE TABLE IF NOT EXISTS alarm_events (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, source TEXT NOT NULL, severity TEXT NOT NULL, text TEXT NOT NULL,
  raised_at INTEGER NOT NULL, cleared_at INTEGER, acked_by TEXT, acked_at INTEGER,
  clear_reason TEXT,        -- recovered | sensor_removed | other
  last_data_at INTEGER);    -- NO UPDATE only: when the sensor's data last changed
CREATE INDEX IF NOT EXISTS idx_alarm_raised ON alarm_events(raised_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_alarm_open ON alarm_events(kind, source) WHERE cleared_at IS NULL;
CREATE TABLE IF NOT EXISTS sync_runs (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, username TEXT NOT NULL, type TEXT NOT NULL, ok INTEGER NOT NULL, result TEXT NOT NULL);
`;
