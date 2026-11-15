// Builds the SCADA / sensor-list view model and the alarm list from the registry, the latest readings and the gateway state.
import type { Db } from "../db.js";
import { rssiBand, sensorStatus, type Status } from "./logic.js";
import { topicFor, type Registry, type SensorRow } from "./registry.js";
import type { GatewayService } from "./service.js";

export interface SensorView {
  serial?: string; slot?: number | null; label: string; type: string; status: Status; zoneId: number | null; intervalSec: number;
  temperature?: number; humidity?: number; voltage?: number; rssi?: number; rssiBand: string; lowVoltage: number;
  raw?: { temperature?: number; humidity?: number }; lastChange: number | null; offlineAfterSec: number;
  calibrated: boolean; calDue: boolean; calDueAt?: number | null; calibratedAt?: number | null; calibratedBy?: string; checkSensor: boolean; applying: boolean; intervalOk: boolean; labelSet?: boolean;
  syncState: "in_gateway" | "not_sent" | "changed"; sentInterval?: number | null; replaced?: boolean;
}
export interface Alarm { kind: "gateway_offline" | "no_update" | "low_battery" | "calibration_due"; severity: "alarm" | "warning"; text: string; serial?: string; since?: number | null; }

export function latestFor(db: Db, type: string) {
  const rows = db.prepare("SELECT s.sensor_key k, s.metric m, l.value v, l.ts t FROM latest l JOIN series s ON s.id=l.series_id WHERE s.topic=?").all(topicFor(type)) as { k: string; m: string; v: number; t: number }[];
  const out = new Map<string, Record<string, { v: number; t: number }>>(); for (const r of rows) { const o = out.get(r.k) ?? {}; o[r.m] = { v: r.v, t: r.t }; out.set(r.k, o); } return out;
}

export function buildView(db: Db, reg: Registry, svc: GatewayService, admin: boolean, now = Date.now()) {
  const st = reg.settings(); const online = svc.online; const sensors: SensorView[] = [];
  const latest = new Map<string, ReturnType<typeof latestFor>>(); for (const t of Object.values(reg.map.types)) if (t.enabled) latest.set(t.key, latestFor(db, t.key));
  const cals = new Map<string, any>(); for (const r of db.prepare("SELECT * FROM calibrations WHERE active=1").all() as any[]) cals.set(`${r.serial}|${r.metric}`, r);
  for (const s of reg.list() as SensorRow[]) {
    const lt = latest.get(s.type)?.get(s.serial) ?? {}; const lowV = st.types[s.type]?.low_voltage ?? 3.2;
    const liveness = svc.detector.liveness({ fp: s.fp, lastChange: s.last_change }, now, s.reporting_interval);
    const status = sensorStatus({ gatewayOnline: online, sent: s.sent_slot !== null, liveness: s.sent_slot === null ? null : liveness, voltage: lt.voltage?.v, lowVoltage: lowV });
    const calRows = ["temperature", "humidity"].map((m) => cals.get(`${s.serial}|${m}`)).filter(Boolean);
    const latestCal = calRows.sort((a, b) => b.calibrated_at - a.calibrated_at)[0];
    const calDueRow = calRows.find((c) => c.due_at !== null && c.due_at < now);
    const v: SensorView = { label: s.label || s.serial, type: s.type, status, zoneId: s.zone_id, intervalSec: s.reporting_interval, temperature: lt.temperature?.v, humidity: lt.humidity?.v, voltage: lt.voltage?.v, rssi: lt.rssi?.v,
      rssiBand: rssiBand(lt.rssi?.v, st.rssiGood, st.rssiPoor), lowVoltage: lowV, lastChange: s.last_change, offlineAfterSec: s.reporting_interval * st.offlineMultiplier, calibrated: calRows.length > 0, calDue: !!calDueRow, calDueAt: calDueRow?.due_at ?? latestCal?.due_at ?? null,
      calibratedAt: latestCal?.calibrated_at ?? null, calibratedBy: latestCal?.calibrated_by, checkSensor: calRows.some((c) => c.check_sensor), applying: s.sent_slot !== null && !s.interval_confirmed, intervalOk: reg.intervalOk(s.type, s.reporting_interval),
      syncState: s.sent_slot === null ? "not_sent" : s.sent_slot !== s.slot || s.sent_interval !== s.reporting_interval ? "changed" : "in_gateway" };
    if (admin) { v.serial = s.serial; v.labelSet = !!s.label; v.slot = s.slot; v.sentInterval = s.sent_interval; v.raw = { temperature: lt.temperature_raw?.v, humidity: lt.humidity_raw?.v }; }
    sensors.push(v);
  }
  const alarms: Alarm[] = [];
  if (svc.enabled && !online) alarms.push({ kind: "gateway_offline", severity: "alarm", text: "Gateway offline: sensor values are unknown", since: svc.lastOk });
  else for (const [i, s] of reg.list().entries()) {
    const v = sensors[i];
    if (v.status === "no_update") alarms.push({ kind: "no_update", severity: "alarm", text: `${v.label}: no update`, serial: s.serial, since: s.last_change });
    if (v.status === "low_battery") alarms.push({ kind: "low_battery", severity: "warning", text: `${v.label}: low battery ${v.voltage?.toFixed(2)} V`, serial: s.serial });
    if (v.calDue) alarms.push({ kind: "calibration_due", severity: "warning", text: `${v.label}: calibration due`, serial: s.serial });
  }
  const zones = reg.zones().map((z) => {
    const ss = reg.list().map((s, i) => ({ s, v: sensors[i] })).filter((x) => x.s.zone_id === z.id); const rep = ss.filter((x) => x.v.status === "ok" || x.v.status === "low_battery");
    const avg = (f: (v: SensorView) => number | undefined) => { const a = rep.map((x) => f(x.v)).filter((n): n is number => typeof n === "number"); return a.length ? Math.round((a.reduce((p, c) => p + c, 0) / a.length) * 10) / 10 : null; };
    const noUp = ss.filter((x) => x.v.status === "no_update" || x.v.status === "no_data").length, low = ss.filter((x) => x.v.status === "low_battery").length;
    const status = !online ? "unknown" : !ss.length ? "empty" : noUp ? "no_update" : low ? "low_battery" : "ok";
    return { id: z.id, name: z.name, type: z.type, status, noUpdate: noUp, lowBattery: low, avgTemperature: avg((v) => v.temperature), avgHumidity: avg((v) => v.humidity), reporting: rep.length, total: ss.length, sensors: ss.map((x) => x.v) };
  });
  return { commissioning: { on: st.commissioning, until: st.commissioningUntil }, gateway: { enabled: svc.enabled, online, lastOk: svc.lastOk, model: reg.map.gateway_model }, zones, sensors, alarms, settings: { rssiGood: st.rssiGood, rssiPoor: st.rssiPoor }, now };
}
