// MQTT Payload source: tables (all CREATE IF NOT EXISTS, additive, nothing existing is altered). Run from openDb().
// mqtt_config.password_enc is AES-GCM ciphertext (secret.ts). Raw messages are NOT stored: the last 20 live in memory only.
export const SCHEMA_MQTT = `
CREATE TABLE IF NOT EXISTS mqtt_config (id INTEGER PRIMARY KEY CHECK (id=1), enabled INTEGER NOT NULL DEFAULT 0, host TEXT NOT NULL, port INTEGER NOT NULL, tls INTEGER NOT NULL DEFAULT 1,
  client_id TEXT NOT NULL DEFAULT '', username TEXT NOT NULL DEFAULT '', password_enc TEXT, keepalive INTEGER NOT NULL DEFAULT 60,
  id_path TEXT NOT NULL, ts_path TEXT NOT NULL, updated_at INTEGER, updated_by TEXT);
CREATE TABLE IF NOT EXISTS mqtt_topics (id INTEGER PRIMARY KEY, filter TEXT NOT NULL UNIQUE, qos INTEGER NOT NULL CHECK (qos IN (0,1,2)));
CREATE TABLE IF NOT EXISTS mqtt_rules (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL UNIQUE, unit TEXT NOT NULL DEFAULT '', scale REAL NOT NULL DEFAULT 1, offset REAL NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS mqtt_devices (device_id TEXT PRIMARY KEY, state TEXT NOT NULL CHECK (state IN ('new','added','ignored')), label TEXT NOT NULL DEFAULT '',
  first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, msg_count INTEGER NOT NULL DEFAULT 0);
`;
