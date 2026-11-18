// PLC data source tables (additive, CREATE IF NOT EXISTS, run from the service constructor like the MQTT tables). One PLC source (id 1) with data zones; each zone has points.
// plc_config.enabled = 1 counts as ONE data source in the licence (licence/usage.ts). No real addresses are shipped: the zone list starts EMPTY.
/** series.topic of every PLC reading; sensor_key = data zone code (DZ1...), metric = point name. */
export const PLC_SERIES_TOPIC = "plc/modbus";
export const SCHEMA_PLC = `
CREATE TABLE IF NOT EXISTS plc_config (id INTEGER PRIMARY KEY CHECK (id=1), enabled INTEGER NOT NULL DEFAULT 0, protocol TEXT NOT NULL DEFAULT 'tcp' CHECK (protocol IN ('tcp','rtu','other')),
  host TEXT NOT NULL DEFAULT '', port INTEGER NOT NULL DEFAULT 502, unit INTEGER NOT NULL DEFAULT 1, rtu_port_id INTEGER, poll_s INTEGER NOT NULL DEFAULT 5, timeout_ms INTEGER NOT NULL DEFAULT 1500,
  word_order TEXT NOT NULL DEFAULT 'big' CHECK (word_order IN ('big','little')), updated_at INTEGER, updated_by TEXT);
CREATE TABLE IF NOT EXISTS plc_zones (id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, farm_zone_id INTEGER REFERENCES zones(id) ON DELETE SET NULL,
  area TEXT NOT NULL CHECK (area IN ('holding','input','coils','discrete')), start INTEGER NOT NULL, length INTEGER NOT NULL, style TEXT NOT NULL DEFAULT 'plc' CHECK (style IN ('plc','protocol')),
  enabled INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS plc_points (id INTEGER PRIMARY KEY, zone_id INTEGER NOT NULL REFERENCES plc_zones(id) ON DELETE CASCADE, off INTEGER NOT NULL, name TEXT NOT NULL,
  type TEXT NOT NULL, scale REAL NOT NULL DEFAULT 1, unit TEXT NOT NULL DEFAULT '', maps_to TEXT NOT NULL DEFAULT '', UNIQUE (zone_id, off), UNIQUE (zone_id, name));
`;
