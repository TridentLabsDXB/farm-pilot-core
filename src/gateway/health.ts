// Builds the SCADA / sensor-list view model and the alarm list from the registry, the latest readings and the gateway state.
import type { Db } from "../db.js";
import { rssiBand, sensorStatus, type Status } from "./logic.js";
import { topicFor, type Registry, type SensorRow } from "./registry.js";
import type { GatewayService } from "./service.js";

/** What an Operator may see of a sensor: values, state words and the label. Nothing about setup: no serial, slot, raw value, calibration, interval or threshold. Built as an allow-list. */
export interface SensorView {
  label: string; type: string; status: Status; zoneId: number | null;
  temperature?: number; humidity?: number; voltage?: number; rssi?: number; rssiBand: string; lastChange: number | null;
  calDue: boolean; checkSensor: boolean; batteryLevel: number; batteryLow: boolean;
}
/** Admin adds the setup details. */
export interface AdminSensorView extends SensorView {
  serial: string; slot: number | null; labelSet: boolean; interval: number; intervalUnit: string; intervalSec: number; offlineAfterSec: number; lowVoltage: number; raw: { temperature?: number; humidity?: number };
  calibrated: boolean; calDueAt: number | null; calibratedAt: number | null; calibratedBy?: string; applying: boolean; intervalOk: boolean; syncState: "in_gateway" | "not_sent" | "changed"; sentInterval: number | null;
}
export interface Alarm { kind: "gateway_offline" | "no_update" | "low_battery" | "calibration_due"; severity: "alarm" | "warning"; text: string; serial?: string; since?: number | null; }

export function latestFor(db: Db, type: string) {
  const rows = db.prepare("SELECT s.sensor_key k, s.metric m, l.value v, l.ts t FROM latest l JOIN series s ON s.id=l.series_id WHERE s.topic=?").all(topicFor(type)) as { k: string; m: string; v: number; t: number }[];
  const out = new Map<string, Record<string, { v: number; t: number }>>(); for (const r of rows) { const o = out.get(r.k) ?? {}; o[r.m] = { v: r.v, t: r.t }; out.set(r.k, o); } return out;
}

/** `internal` = the alarm tracker's own call: operator labels, but alarms keep their `serial` (needed to key the alarm history). It is never sent to a client. */
export function buildView(db: Db, reg: Registry, svc: GatewayService, admin: boolean, now = Date.now(), internal = false) {
  const st = reg.settings(); const online = svc.online; const sensors: (SensorView | AdminSensorView)[] = [];
  const latest = new Map<string, ReturnType<typeof latestFor>>(); for (const t of Object.values(reg.map.types)) if (t.enabled) latest.set(t.key, latestFor(db, t.key));
  const cals = new Map<string, any>(); for (const r of db.prepare("SELECT * FROM calibrations WHERE active=1").all() as any[]) cals.set(`${r.serial}|${r.metric}`, r);
  for (const [idx, s] of (reg.list() as SensorRow[]).entries()) {
    const lt = latest.get(s.type)?.get(s.serial) ?? {}; const lowV = st.types[s.type]?.low_voltage ?? 3.2;
    const liveness = svc.detector.liveness({ fp: s.fp, lastChange: s.last_change }, now, reg.intervalSec(s.type, s.reporting_interval));
    const status = sensorStatus({ gatewayOnline: online, sent: s.sent_slot !== null, liveness: s.sent_slot === null ? null : liveness, voltage: lt.voltage?.v, lowVoltage: lowV });
    const calRows = ["temperature", "humidity"].map((m) => cals.get(`${s.serial}|${m}`)).filter(Boolean);
    const latestCal = calRows.sort((a, b) => b.calibrated_at - a.calibrated_at)[0];
    const calDueRow = calRows.find((c) => c.due_at !== null && c.due_at < now);
    const lowBound = lowV - 0.4, level = lt.voltage ? Math.max(0, Math.min(1, (lt.voltage.v - lowBound) / (3.6 - lowBound))) : 0;      // icon bounds are ASSUMED (README)
    const base: SensorView = { label: s.label || (admin ? s.serial : `Sensor ${idx + 1}`), type: s.type, status, zoneId: s.zone_id, temperature: lt.temperature?.v, humidity: lt.humidity?.v, voltage: lt.voltage?.v, rssi: lt.rssi?.v,
      rssiBand: rssiBand(lt.rssi?.v, st.rssiGood, st.rssiPoor), lastChange: s.last_change, calDue: !!calDueRow, checkSensor: calRows.some((c) => c.check_sensor), batteryLevel: level, batteryLow: !!lt.voltage && lt.voltage.v < lowV };
    const v: SensorView | AdminSensorView = !admin ? base : { ...base, serial: s.serial, slot: s.slot, labelSet: !!s.label, interval: s.reporting_interval, intervalUnit: reg.unitName(s.type), intervalSec: reg.intervalSec(s.type, s.reporting_interval), offlineAfterSec: reg.intervalSec(s.type, s.reporting_interval) * st.offlineMultiplier, lowVoltage: lowV,
      raw: { temperature: lt.temperature_raw?.v, humidity: lt.humidity_raw?.v }, calibrated: calRows.length > 0, calDueAt: calDueRow?.due_at ?? latestCal?.due_at ?? null, calibratedAt: latestCal?.calibrated_at ?? null, calibratedBy: latestCal?.calibrated_by,
      applying: s.sent_slot !== null && !s.interval_confirmed, intervalOk: reg.intervalOk(s.type, s.reporting_interval), sentInterval: s.sent_interval,
      syncState: s.sent_slot === null ? "not_sent" : s.sent_slot !== s.slot || s.sent_interval !== s.reporting_interval ? "changed" : "in_gateway" };
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
  if (!admin && !internal) for (const a of alarms) delete a.serial;                          // Operators get alarm texts (with the operator label), never the serial
  const zones = reg.zones().map((z) => {
    const ss = reg.list().map((s, i) => ({ s, v: sensors[i] })).filter((x) => x.s.zone_id === z.id); const rep = ss.filter((x) => x.v.status === "ok" || x.v.status === "low_battery");
    const avg = (f: (v: SensorView) => number | undefined) => { const a = rep.map((x) => f(x.v)).filter((n): n is number => typeof n === "number"); return a.length ? Math.round((a.reduce((p, c) => p + c, 0) / a.length) * 10) / 10 : null; };
    const noUp = ss.filter((x) => x.v.status === "no_update" || x.v.status === "no_data").length, low = ss.filter((x) => x.v.status === "low_battery").length;
    const status = !online ? "unknown" : !ss.length ? "empty" : noUp ? "no_update" : low ? "low_battery" : "ok";
    return { id: z.id, name: z.name, type: z.type, status, noUpdate: noUp, lowBattery: low, avgTemperature: avg((v) => v.temperature), avgHumidity: avg((v) => v.humidity), reporting: rep.length, total: ss.length, sensors: ss.map((x) => x.v) };
  });
  return { commissioning: { on: st.commissioning, until: st.commissioningUntil }, gateway: { enabled: svc.enabled, online, lastOk: svc.lastOk, model: reg.map.gateway_model }, zones, sensors, alarms, ...(admin ? { settings: { rssiGood: st.rssiGood, rssiPoor: st.rssiPoor } } : {}), now };
}
