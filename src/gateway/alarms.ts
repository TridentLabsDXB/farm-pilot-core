// Alarm history. The live alarm list is computed on demand by buildView; this tracker compares it with the open rows of alarm_events every few seconds:
// a new alarm opens a row (raised_at), an alarm that is gone closes it (cleared_at + clear_reason). Acknowledging records who and when. One open row per (kind, source).
// FREEZE: while the gateway is offline nothing is known about the sensors, so sensor alarms are neither raised nor cleared. Open ones stay open and are reported as "unknown".
import type { Db } from "../db.js";
import { audit } from "../db.js";
import { buildView, type Alarm } from "./health.js";
import { HttpError, type Registry } from "./registry.js";
import type { GatewayService } from "./service.js";

export interface AlarmEvent { id: number; kind: string; source: string; severity: string; text: string; raised_at: number; cleared_at: number | null; acked_by: string | null; acked_at: number | null; clear_reason: string | null; last_data_at: number | null; unknown?: boolean; }
// 2026-11-16 -- "other" used to hide three different things. Reasons now: recovered | sensor_removed | not_sent (sensor reset to NOT SENT by a re-sync / config change)
// | no_data (sensor sends nothing at all, so it is no longer "no update") | ended (the condition went away and none of the above applies; shown as CONDITION ENDED).
// Old rows keep the stored value "other"; the web app shows it with the same CONDITION ENDED label.
export type ClearReason = "recovered" | "sensor_removed" | "not_sent" | "no_data" | "ended" | "other";
export interface SensorFacts { status: string; calDue: boolean; lastChange: number | null; }
/** What the tracker needs to know about the world. Default (tests): gateway online, no sensor information. */
export interface SyncContext { gatewayOnline: boolean; settling?: boolean; sensor: (serial: string) => SensorFacts | null | undefined; }
export const alarmSource = (a: Alarm) => a.serial ?? "gateway";
const NO_CONTEXT: SyncContext = { gatewayOnline: true, sensor: () => undefined };

/** Why an alarm that is no longer active went away. "other" = the condition is not met any more but the sensor is not simply healthy (e.g. it was reset to NOT SENT). */
export function clearReason(kind: string, facts: SensorFacts | null | undefined, known: boolean): ClearReason {
  if (kind === "gateway_offline") return "recovered";
  if (known && !facts) return "sensor_removed";
  if (!facts) return "ended";
  if (kind === "calibration_due") return facts.calDue ? "ended" : "recovered";
  if (facts.status === "not_sent") return "not_sent"; if (facts.status === "no_data") return "no_data";
  return facts.status === "ok" || (kind === "low_battery" && facts.status !== "low_battery") ? "recovered" : "ended";
}

/** After a runtime restart, and after a gateway Send / re-sync, the polling has been paused or has not delivered a fresh frame yet, so "no update" would be measured against old data. */
export const SETTLE_MS = 120_000;
export class AlarmTracker {
  private startedAt = Date.now(); private lastSyncSeen = 0;
  constructor(private db: Db, private reg: Registry, private svc: GatewayService) {}
  private context(now: number): { alarms: Alarm[]; ctx: SyncContext } {
    const view = buildView(this.db, this.reg, this.svc, false, now, true); const list = this.reg.list(); const facts = new Map<string, SensorFacts>();
    list.forEach((s, i) => facts.set(s.serial, { status: view.sensors[i].status, calDue: view.sensors[i].calDue, lastChange: s.last_change }));
    if (this.svc?.syncing) this.lastSyncSeen = now;
    // 2026-11-16 -- no NO UPDATE alarm is RAISED while settling (first SETTLE_MS after start, during a gateway sync, SETTLE_MS after one). One that is still true afterwards is raised then.
    const settling = now - this.startedAt < SETTLE_MS || !!this.svc?.syncing || now - this.lastSyncSeen < SETTLE_MS;
    return { alarms: view.alarms, ctx: { settling, gatewayOnline: !view.gateway.enabled || view.gateway.online, sensor: (serial) => facts.get(serial) ?? null } };
  }
  tick(now = Date.now()) { const { alarms, ctx } = this.context(now); this.sync(alarms, now, ctx); }
  sync(alarms: Alarm[], now = Date.now(), ctx: SyncContext = NO_CONTEXT) {
    const open = this.db.prepare("SELECT id,kind,source FROM alarm_events WHERE cleared_at IS NULL").all() as { id: number; kind: string; source: string }[];
    const live = new Map(alarms.map((a) => [a.kind + "|" + alarmSource(a), a]));
    this.db.transaction(() => {
      for (const o of open) {
        if (live.has(o.kind + "|" + o.source)) continue;
        const facts = o.kind === "gateway_offline" ? undefined : ctx.sensor(o.source); const sensorGone = o.kind !== "gateway_offline" && facts === null;
        if (o.kind !== "gateway_offline" && !ctx.gatewayOnline && !sensorGone) continue;                                           // FREEZE: gateway offline, status unknown, keep it open
        this.db.prepare("UPDATE alarm_events SET cleared_at=?, clear_reason=? WHERE id=?").run(now, clearReason(o.kind, facts, ctx.sensor !== NO_CONTEXT.sensor), o.id);
      }
      const have = new Set(open.map((o) => o.kind + "|" + o.source));
      for (const [k, a] of live) {
        if (have.has(k)) continue; if (a.kind !== "gateway_offline" && !ctx.gatewayOnline) continue; if (a.kind === "no_update" && ctx.settling) continue;                                // never raise a sensor alarm from stale data
        const last = a.kind === "no_update" ? (ctx.sensor(alarmSource(a))?.lastChange ?? a.since ?? null) : null;
        this.db.prepare("INSERT INTO alarm_events(kind,source,severity,text,raised_at,last_data_at) VALUES(?,?,?,?,?,?)").run(a.kind, alarmSource(a), a.severity, a.text, now, last);   // raised_at = when CORE detected it
      }
    })();
  }
  history(limit = 50, admin = false) {
    const gwOffline = !!this.svc && this.svc.enabled && !this.svc.online;
    const rows = this.db.prepare("SELECT * FROM alarm_events ORDER BY (cleared_at IS NULL) DESC, raised_at DESC, id DESC LIMIT ?").all(Math.max(1, Math.min(500, limit))) as AlarmEvent[];
    return rows.map((r) => ({ ...r, source: admin ? r.source : "", unknown: r.cleared_at === null && r.kind !== "gateway_offline" && gwOffline }));      // Operators never see serials
  }
  ack(user: { username: string; role: string }, id: number, now = Date.now()) {
    const r = this.db.prepare("SELECT * FROM alarm_events WHERE id=?").get(id) as AlarmEvent | undefined; if (!r) throw new HttpError(404, "alarm not found");
    if (r.acked_at) return r;                                                         // already acknowledged: keep the first acknowledgement
    this.db.prepare("UPDATE alarm_events SET acked_by=?, acked_at=? WHERE id=?").run(user.username, now, id);
    audit(this.db, user.username, user.role, "alarm.ack", { id, kind: r.kind });
    return { ...r, acked_by: user.username, acked_at: now };
  }
}
