// RS-485 Ports: tables, first-start migration of the environment-file gateway link, and row access. No sockets here.
import type { Db } from "../db.js";
import { PORT_DEFAULTS, type DeviceRow, type PortRow } from "./validate.js";

export const SCHEMA_PORTS = `
CREATE TABLE IF NOT EXISTS serial_ports (
  id INTEGER PRIMARY KEY, label TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, transport TEXT NOT NULL DEFAULT 'serial' CHECK (transport IN ('serial','tcp')),
  device_path TEXT NOT NULL DEFAULT '', tcp_host TEXT NOT NULL DEFAULT '', tcp_port INTEGER NOT NULL DEFAULT 502, tcp_framing TEXT NOT NULL DEFAULT 'rtu' CHECK (tcp_framing IN ('rtu','mbap')),
  baud INTEGER NOT NULL DEFAULT 9600, data_bits INTEGER NOT NULL DEFAULT 8, parity TEXT NOT NULL DEFAULT 'none', stop_bits INTEGER NOT NULL DEFAULT 1,
  timeout_ms INTEGER NOT NULL DEFAULT 1500, retries INTEGER NOT NULL DEFAULT 2, turnaround_ms INTEGER NOT NULL DEFAULT 50,
  last_good TEXT,                       -- JSON of the last settings that answered, used by REVERT
  updated_at INTEGER, updated_by TEXT);
CREATE TABLE IF NOT EXISTS bus_devices (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL UNIQUE, model TEXT NOT NULL, port_id INTEGER NOT NULL REFERENCES serial_ports(id),
  modbus_address INTEGER NOT NULL, poll_interval_s INTEGER NOT NULL DEFAULT 30, enabled INTEGER NOT NULL DEFAULT 1);
`;

export interface EnvLink { transport: "off" | "tcp" | "rtu-tcp" | "rtu-serial"; host: string; port: number; serialPath: string; baud: number; parity: "none" | "even" | "odd"; address: number; timeoutMs: number; retries: number; }

const toPort = (r: any): PortRow => ({ id: r.id, label: r.label, enabled: !!r.enabled, transport: r.transport, device_path: r.device_path, tcp_host: r.tcp_host, tcp_port: r.tcp_port, tcp_framing: r.tcp_framing,
  baud: r.baud, data_bits: r.data_bits, parity: r.parity, stop_bits: r.stop_bits, timeout_ms: r.timeout_ms, retries: r.retries, turnaround_ms: r.turnaround_ms });
const toDev = (r: any): DeviceRow => ({ id: r.id, kind: r.kind, model: r.model, port_id: r.port_id, modbus_address: r.modbus_address, poll_interval_s: r.poll_interval_s, enabled: !!r.enabled });

export class PortStore {
  constructor(private db: Db) { db.exec(SCHEMA_PORTS); }
  ports(): PortRow[] { return (this.db.prepare("SELECT * FROM serial_ports ORDER BY id").all() as any[]).map(toPort); }
  port(id: number): PortRow | undefined { const r = this.db.prepare("SELECT * FROM serial_ports WHERE id=?").get(id); return r ? toPort(r) : undefined; }
  devices(): DeviceRow[] { return (this.db.prepare("SELECT * FROM bus_devices ORDER BY id").all() as any[]).map(toDev); }
  device(id: number): DeviceRow | undefined { const r = this.db.prepare("SELECT * FROM bus_devices WHERE id=?").get(id); return r ? toDev(r) : undefined; }
  lastGood(id: number): PortRow | null { const r = this.db.prepare("SELECT last_good FROM serial_ports WHERE id=?").get(id) as { last_good: string | null } | undefined; try { return r?.last_good ? JSON.parse(r.last_good) : null; } catch { return null; } }
  setLastGood(id: number, p: PortRow) { this.db.prepare("UPDATE serial_ports SET last_good=? WHERE id=?").run(JSON.stringify(p), id); }
  savePort(p: PortRow, by: string) {
    this.db.prepare(`UPDATE serial_ports SET label=?,enabled=?,transport=?,device_path=?,tcp_host=?,tcp_port=?,tcp_framing=?,baud=?,data_bits=?,parity=?,stop_bits=?,timeout_ms=?,retries=?,turnaround_ms=?,updated_at=?,updated_by=? WHERE id=?`)
      .run(p.label, p.enabled ? 1 : 0, p.transport, p.device_path, p.tcp_host, p.tcp_port, p.tcp_framing, p.baud, p.data_bits, p.parity, p.stop_bits, p.timeout_ms, p.retries, p.turnaround_ms, Date.now(), by, p.id);
  }
  saveDevice(d: DeviceRow) { this.db.prepare("UPDATE bus_devices SET port_id=?,modbus_address=?,poll_interval_s=?,enabled=? WHERE id=?").run(d.port_id, d.modbus_address, d.poll_interval_s, d.enabled ? 1 : 0, d.id); }

  /** 2026-11-18: the Ashining A100 link. One row (kind is UNIQUE), no Modbus address (stored as 0, never read). Called only by the A100 service after the Ports rules passed. */
  upsertFanLink(portId: number, enabled: boolean) {
    const r = this.db.prepare("SELECT id FROM bus_devices WHERE kind='fan_link'").get() as { id: number } | undefined;
    if (r) this.db.prepare("UPDATE bus_devices SET port_id=?, enabled=? WHERE id=?").run(portId, enabled ? 1 : 0, r.id);
    else this.db.prepare("INSERT INTO bus_devices(kind,model,port_id,modbus_address,poll_interval_s,enabled) VALUES('fan_link','A100-L400M30',?,0,60,?)").run(portId, enabled ? 1 : 0);
  }

  /** Backup / restore of both tables in one piece. Ports keep their ids; devices reference them. */
  exportAll() { return { ports: this.ports(), devices: this.devices() }; }
  replaceAll(ports: PortRow[], devices: DeviceRow[], by: string) {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM bus_devices").run(); this.db.prepare("DELETE FROM serial_ports").run();
      for (const p of ports) { this.insertPort(p); this.savePort(p, by); }
      for (const d of devices) this.db.prepare("INSERT INTO bus_devices(id,kind,model,port_id,modbus_address,poll_interval_s,enabled) VALUES(?,?,?,?,?,?,?)").run(d.id, d.kind, d.model, d.port_id, d.modbus_address, d.poll_interval_s, d.enabled ? 1 : 0);
    })();
  }
  private insertPort(p: PortRow) { this.db.prepare("INSERT INTO serial_ports(id,label) VALUES(?,?)").run(p.id, p.label); }

  /** One-time repair (flag in `settings`): until 2026-11-17 the UI could not switch a device off, so every device row with enabled=0 is the old "env gateway off" seed, not a decision. Switch them on;
   *  the port's own Enabled flag still decides whether anything is opened. Returns the number of rows changed. */
  repairDeviceFlags(): number {
    const KEY = "bus_devices_on_by_default"; if (this.db.prepare("SELECT 1 FROM settings WHERE key=?").get(KEY)) return 0;
    const n = this.db.prepare("UPDATE bus_devices SET enabled=1 WHERE enabled=0").run().changes; this.db.prepare("INSERT INTO settings(key,value) VALUES(?,?)").run(KEY, "1"); return n;
  }

  /** First start: today's gateway link (environment file) becomes Port 1 + the LoRa Sensor Gateway device, so a running box changes nothing. Port 2 and the weather station are created OFF
   *  (NOT CONNECTED until the Admin picks a device). Runs once: later changes live in the database, and the environment values are only these initial defaults. */
  migrateFromEnv(env: EnvLink, defaultGatewayAddress: number) {
    if ((this.db.prepare("SELECT COUNT(*) c FROM serial_ports").get() as { c: number }).c > 0) return false;
    const off = env.transport === "off", serial = env.transport === "rtu-serial";
    const p1: PortRow = { id: 1, label: "Port 1 - LoRa gateway", enabled: !off, transport: serial ? "serial" : "tcp", device_path: serial ? env.serialPath : "", tcp_host: serial ? "" : env.host, tcp_port: serial ? 502 : env.port,
      tcp_framing: env.transport === "tcp" ? "mbap" : "rtu", baud: env.baud, data_bits: 8, parity: env.parity, stop_bits: 1, timeout_ms: env.timeoutMs, retries: env.retries, turnaround_ms: PORT_DEFAULTS.turnaround_ms };
    const p2: PortRow = { id: 2, label: "Port 2 - Weather station", enabled: false, transport: "serial", device_path: "", tcp_host: "", tcp_port: 502, tcp_framing: "rtu", baud: 9600, data_bits: 8, parity: "none", stop_bits: 1, timeout_ms: 1500, retries: 2, turnaround_ms: 50 };
    this.db.transaction(() => {
      for (const p of [p1, p2]) { this.insertPort(p); this.savePort(p, "migration"); this.setLastGood(p.id, p); }
      const ins = this.db.prepare("INSERT INTO bus_devices(kind,model,port_id,modbus_address,poll_interval_s,enabled) VALUES(?,?,?,?,?,?)");
      // 2026-11-17 (Windows lab): the device was seeded OFF when GW_TRANSPORT=off, and the Devices table has no switch for it, so ticking Enabled on Port 1 never started polling
      // ("(switched off)" on the Gateway page, NO GATEWAY, counters 0/0). The PORT is the switch; the device row is seeded ON. See repairDeviceFlags() for boxes that already have the old seed.
      ins.run("lora_gateway", "XZ-DS-MUS2", 1, env.address || defaultGatewayAddress, 30, 1);
      ins.run("weather", "WN90LP", 2, 144, 30, 1);                 // 144 = 0x90, probably the factory address (to verify with the manual)
    })();
    return true;
  }
}
