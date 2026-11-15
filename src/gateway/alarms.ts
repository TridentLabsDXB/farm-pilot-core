// Alarm history. The live alarm list is computed on demand by buildView; this tracker compares it with the open rows of alarm_events every few seconds:
// a new alarm opens a row (raised_at), an alarm that is gone closes it (cleared_at). Acknowledging records who and when. One open row per (kind, source).
import type { Db } from "../db.js";
import { audit } from "../db.js";
import { buildView, type Alarm } from "./health.js";
import { HttpError, type Registry } from "./registry.js";
import type { GatewayService } from "./service.js";

export interface AlarmEvent { id: number; kind: string; source: string; severity: string; text: string; raised_at: number; cleared_at: number | null; acked_by: string | null; acked_at: number | null; }
export const alarmSource = (a: Alarm) => a.serial ?? "gateway";

export class AlarmTracker {
  constructor(private db: Db, private reg: Registry, private svc: GatewayService) {}
  tick(now = Date.now()) { this.sync(buildView(this.db, this.reg, this.svc, false, now).alarms, now); }
  sync(alarms: Alarm[], now = Date.now()) {
    const open = this.db.prepare("SELECT id,kind,source FROM alarm_events WHERE cleared_at IS NULL").all() as { id: number; kind: string; source: string }[];
    const live = new Map(alarms.map((a) => [a.kind + "|" + alarmSource(a), a]));
    this.db.transaction(() => {
      for (const o of open) if (!live.has(o.kind + "|" + o.source)) this.db.prepare("UPDATE alarm_events SET cleared_at=? WHERE id=?").run(now, o.id);
      const have = new Set(open.map((o) => o.kind + "|" + o.source));
      for (const [k, a] of live) if (!have.has(k)) this.db.prepare("INSERT INTO alarm_events(kind,source,severity,text,raised_at) VALUES(?,?,?,?,?)").run(a.kind, alarmSource(a), a.severity, a.text, now);          // raised_at = when CORE detected it (for NO UPDATE the sensor stopped earlier: see the alarm text)
    })();
  }
  history(limit = 50, admin = false) {
    const rows = this.db.prepare("SELECT * FROM alarm_events ORDER BY (cleared_at IS NULL) DESC, raised_at DESC, id DESC LIMIT ?").all(Math.max(1, Math.min(500, limit))) as AlarmEvent[];
    return rows.map((r) => (admin ? r : { ...r, source: "" }));                       // Operators never see serials
  }
  ack(user: { username: string; role: string }, id: number, now = Date.now()) {
    const r = this.db.prepare("SELECT * FROM alarm_events WHERE id=?").get(id) as AlarmEvent | undefined; if (!r) throw new HttpError(404, "alarm not found");
    if (r.acked_at) return r;                                                         // already acknowledged: keep the first acknowledgement
    this.db.prepare("UPDATE alarm_events SET acked_by=?, acked_at=? WHERE id=?").run(user.username, now, id);
    audit(this.db, user.username, user.role, "alarm.ack", { id, kind: r.kind });
    return { ...r, acked_by: user.username, acked_at: now };
  }
}
