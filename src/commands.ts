import { randomUUID } from "node:crypto";
import type { MqttClient } from "mqtt";
import { audit, getSetting, type Db } from "./db.js";
import { config } from "./config.js";

export type CmdStatus = "sent" | "confirmed" | "timeout";
export interface CommandRow { id: string; pump: string; action: "on" | "off"; status: CmdStatus; username: string; role: string; created_at: number; resolved_at: number | null; note: string | null; }
export const PUMPS = ["pump1"];

export const cmdTopic = (pump: string) => `farmpilot/${config.farm}/cmd/${pump}`;
export const ackTopic = (pump: string) => `farmpilot/${config.farm}/ack/${pump}`;
export const timeoutMs = (db: Db) => Math.max(3, Number(getSetting(db, "command_timeout_sec", String(config.commandTimeoutSec)))) * 1000;

export class Commands {
  constructor(private db: Db, private mqtt: MqttClient, private emit: (c: CommandRow) => void) {}

  // On boot: nothing is ever re-published. Anything still 'sent' from the previous run is closed as timeout.
  closeStaleOnBoot() {
    const rows = this.db.prepare("SELECT * FROM commands WHERE status='sent'").all() as CommandRow[];
    for (const r of rows) this.resolve(r.id, "timeout", "runtime restarted before acknowledgement; not re-sent");
  }

  create(user: { username: string; role: string }, pump: string, action: "on" | "off", now = Date.now()): { cmd: CommandRow; deduped: boolean } {
    // Double-tap guard: same pump + same action inside the window returns the existing command and publishes nothing.
    const dup = this.db.prepare("SELECT * FROM commands WHERE pump=? AND action=? AND created_at > ? ORDER BY created_at DESC LIMIT 1").get(pump, action, now - config.dedupeWindowMs) as CommandRow | undefined;
    if (dup) return { cmd: dup, deduped: true };
    const cmd: CommandRow = { id: randomUUID(), pump, action, status: "sent", username: user.username, role: user.role, created_at: now, resolved_at: null, note: null };
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO commands(id,pump,action,status,username,role,created_at) VALUES(?,?,?,?,?,?,?)").run(cmd.id, pump, action, "sent", user.username, user.role, now);
      audit(this.db, user.username, user.role, "pump.command", { cmd_id: cmd.id, pump, action });
    })();
    // QoS 1, NOT retained: a late subscriber (or a restarted simulator) never receives an old command.
    this.mqtt.publish(cmdTopic(pump), JSON.stringify({ cmd_id: cmd.id, action, ts: now, by: user.username }), { qos: 1, retain: false });
    this.emit(cmd);
    return { cmd, deduped: false };
  }

  onAck(buf: Buffer) {
    let p: any; try { p = JSON.parse(buf.toString("utf8")); } catch { return; }
    if (!p || typeof p.cmd_id !== "string") return;
    const row = this.db.prepare("SELECT * FROM commands WHERE id=?").get(p.cmd_id) as CommandRow | undefined;
    if (!row) return;
    if (row.status === "sent") this.resolve(row.id, p.ok === false ? "timeout" : "confirmed", p.ok === false ? "device rejected command" : null);
    else audit(this.db, "system", "system", "pump.ack.late", { cmd_id: row.id, status: row.status });
  }

  sweep(now = Date.now()) {
    const limit = timeoutMs(this.db);
    const rows = this.db.prepare("SELECT id FROM commands WHERE status='sent' AND created_at < ?").all(now - limit) as { id: string }[];
    for (const r of rows) this.resolve(r.id, "timeout", "no acknowledgement in time", now);
  }

  private resolve(id: string, status: CmdStatus, note: string | null, now = Date.now()) {
    this.db.prepare("UPDATE commands SET status=?, resolved_at=?, note=? WHERE id=? AND status='sent'").run(status, now, note, id);
    audit(this.db, "system", "system", `pump.command.${status}`, { cmd_id: id, note });
    this.emit(this.db.prepare("SELECT * FROM commands WHERE id=?").get(id) as CommandRow);
  }

  recent(limit = 10) { return this.db.prepare("SELECT * FROM commands ORDER BY created_at DESC LIMIT ?").all(limit) as CommandRow[]; }
}
