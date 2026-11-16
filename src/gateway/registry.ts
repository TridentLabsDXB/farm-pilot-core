// Sensor registry, zones, calibration, settings, backup. All writes audit. Pure SQLite, no Modbus.
import { audit, getSetting, setSetting, type Db } from "../db.js";
import { profileThresholds } from "./thresholds.js";
import type { RegMap } from "../drivers/modbus/regmap.js";
import { applyCal, checkLimits, DEFAULT_LIMITS, offsetCal, twoPointCal, type Cal, type Limits } from "./logic.js";

export interface Actor { username: string; role: string; }
export class HttpError extends Error { constructor(public status: number, m: string, public extra?: unknown) { super(m); } }
const bad = (m: string, extra?: unknown) => new HttpError(400, m, extra);
export interface SensorRow { serial: string; type: string; label: string; zone_id: number | null; slot: number | null; reporting_interval: number; created_at: number; replaced_by: string | null;
  thresholds: string | null; sent_slot: number | null; sent_interval: number | null; interval_changed_at: number | null; interval_confirmed: number; fp: string | null; last_change: number | null; }

export const topicFor = (type: string) => `gateway/${type}`;

export const COMMISSIONING_MS = 8 * 3600_000;
export class Registry {
  now = () => Date.now();                                  // replaceable clock (tests)
  constructor(private db: Db, public map: RegMap) {}
  /** Commissioning mode (short T/H intervals allowed). Switches itself off after 8 hours; the automatic switch-off is audited as user "system". Checked on every read, so it holds even if no timer runs. */
  commissioning(): { on: boolean; until: number | null } {
    if (getSetting(this.db, "gw.commissioning", "0") !== "1") return { on: false, until: null };
    const now = this.now(); let since = Number(getSetting(this.db, "gw.commissioning_since", "0"));
    if (!since) { since = now; setSetting(this.db, "gw.commissioning_since", String(since)); }
    if (now - since >= COMMISSIONING_MS) { setSetting(this.db, "gw.commissioning", "0"); setSetting(this.db, "gw.commissioning_since", "0"); audit(this.db, "system", "system", "gateway.commissioning.auto_off", { since, after_hours: 8 }); return { on: false, until: null }; }
    return { on: true, until: since + COMMISSIONING_MS };
  }
  // ---- settings ----
  settings() {
    const g = (k: string, d: number) => Number(getSetting(this.db, k, String(d)));
    // Precedence: register-map default < Farm Profile (read on every call, so changes apply without a restart).
    const pt = profileThresholds(this.db); const types: Record<string, { low_voltage: number }> = {}; for (const t of Object.values(this.map.types)) types[t.key] = { low_voltage: pt.lowVoltageByType[t.key] ?? t.low_voltage };
    const c = this.commissioning();
    return { commissioning: c.on, commissioningUntil: c.until, pollSec: g("gw.poll_sec", 30), offlineMultiplier: pt.offlineMultiplier ?? this.map.health.offline_multiplier, staleMultiplier: pt.staleMultiplier ?? this.map.health.offline_multiplier, offlineCycles: g("gw.offline_cycles", 3), rssiGood: pt.rssiGood ?? this.map.health.rssi_good_above, rssiPoor: pt.rssiWeak ?? this.map.health.rssi_poor_below,
      calDueWarnDays: pt.calibrationDueDays ?? 0, types, limits: this.limits() };
  }
  limits(): Record<string, Limits> { try { return { ...DEFAULT_LIMITS, ...JSON.parse(getSetting(this.db, "cal.limits", "{}")) }; } catch { return DEFAULT_LIMITS; } }
  saveSettings(a: Actor, b: any) {
    const num = (v: unknown, lo: number, hi: number, name: string) => { const n = Number(v); if (!Number.isFinite(n) || n < lo || n > hi) throw bad(`${name} must be ${lo}..${hi}`); return n; };
    if (b.commissioning !== undefined) { if (typeof b.commissioning !== "boolean") throw bad("commissioning must be true or false"); if (b.commissioning && !Object.values(this.map.types).some((t) => t.commissioning_presets.length)) throw bad("no sensor type has shorter commissioning intervals on this gateway"); const was = this.commissioning().on; setSetting(this.db, "gw.commissioning", b.commissioning ? "1" : "0"); if (b.commissioning && !was) setSetting(this.db, "gw.commissioning_since", String(this.now())); if (!b.commissioning) setSetting(this.db, "gw.commissioning_since", "0"); }
    for (const k of ["offlineMultiplier", "rssiGood", "rssiPoor", "types"]) if (b[k] !== undefined) throw bad(`${k} moved to Settings > Farm Profile (Defaults and thresholds)`);
    if (b.pollSec !== undefined) setSetting(this.db, "gw.poll_sec", String(num(b.pollSec, 10, 3600, "pollSec")));
    if (b.limits) setSetting(this.db, "cal.limits", JSON.stringify(b.limits));
    audit(this.db, a.username, a.role, "gateway.settings", b);
  }

  // ---- reporting intervals ----
  // Intervals are stored and sent in the GATEWAY's unit (T/H: minutes, 5..240; CONFIRMED value 5 on the bench, unit and range from the MDMS manual, rate check pending).
  // `presets` are what the UI offers; any whole number inside config.interval.min..max is accepted too (custom value). 30 s and 1 min do not exist on this gateway.
  // A type that lists `commissioning_presets` (none today) can allow shorter values while the Admin commissioning option is on. A stored value outside the rule (adopted from the gateway, old backup) stays displayable and is flagged.
  allowedIntervals(type: string): number[] { const t = this.map.types[type]; return [...t.presets, ...(this.settings().commissioning ? t.commissioning_presets : [])].sort((a, b) => a - b); }
  intervalOk(type: string, v: number) { const c = this.map.types[type].config.interval; return Number.isInteger(v) && ((v >= c.min && v <= c.max) || this.allowedIntervals(type).includes(v)); }
  unitName(type: string) { return this.map.types[type].config.interval.unit; }
  /** Interval in seconds, for timing (offline threshold, poll period, update-rate check). */
  intervalSec(type: string, v: number) { return v * this.map.types[type].config.interval.unit_sec; }

  // ---- sensors ----
  list(): SensorRow[] { return this.db.prepare("SELECT * FROM sensors WHERE replaced_by IS NULL ORDER BY type, COALESCE(slot, 999), serial").all() as SensorRow[]; }
  all(): SensorRow[] { return this.db.prepare("SELECT * FROM sensors ORDER BY type, serial").all() as SensorRow[]; }
  get(serial: string): SensorRow | undefined { return this.db.prepare("SELECT * FROM sensors WHERE serial=?").get(serial) as SensorRow | undefined; }
  typeDef(type: string) { const t = this.map.types[type]; if (!t) throw bad("unknown sensor type"); if (!t.enabled) throw bad(`sensor type ${type} is not enabled in this milestone`); return t; }
  validSerial(s: string) {
    const n = s.trim(); if (!this.map.serial_pattern.test(n) || /^0/.test(n)) throw bad(`invalid serial "${s}": expected the plain decimal number printed on the sensor label (pattern ${this.map.serial_pattern.source}, no leading zero)`);
    if (Number(n) > 0xfffffffe) throw bad(`invalid serial "${s}": does not fit the gateway's 32-bit address`); return n;
  }
  usage(type: string) { const n = (this.db.prepare("SELECT COUNT(*) c FROM sensors WHERE type=? AND replaced_by IS NULL").get(type) as { c: number }).c; return { used: n, groups: this.map.types[type].groups }; }
  /** Slots held by registry sensors, pending removals and groups last seen in the gateway (foreign). */
  takenSlots(type: string, gatewaySeen: number[] = []): Set<number> {
    const s = new Set<number>(gatewaySeen);
    for (const r of this.db.prepare("SELECT slot FROM sensors WHERE type=? AND slot IS NOT NULL AND replaced_by IS NULL").all(type) as { slot: number }[]) s.add(r.slot);
    for (const r of this.db.prepare("SELECT slot FROM pending_removals WHERE type=? AND slot IS NOT NULL").all(type) as { slot: number }[]) s.add(r.slot);
    return s;
  }
  add(a: Actor, type: string, serials: string[], gatewaySeen: number[] = [], labels: Record<string, string> = {}) {
    const t = this.typeDef(type); const norm = serials.map((s) => this.validSerial(s)); const uniq = [...new Set(norm)];
    if (uniq.length !== norm.length) throw bad("duplicate serials in the list");
    for (const s of uniq) if (this.get(s)) throw bad(`serial ${s} already exists`);
    const { used } = this.usage(type); if (used + uniq.length > t.groups) throw bad(`${t.label} is full: ${used} of ${t.groups} slots used, cannot add ${uniq.length}`);
    const taken = this.takenSlots(type, gatewaySeen); const now = Date.now();
    this.db.transaction(() => {
      for (const s of uniq) {
        let slot: number | null = null; for (let i = 1; i <= t.groups; i++) if (!taken.has(i)) { slot = i; break; }
        if (slot === null) throw bad(`${t.label} has no free slot (slots held by other sensors or the gateway)`);
        taken.add(slot);
        this.db.prepare("INSERT INTO sensors(serial,type,label,slot,reporting_interval,created_at) VALUES(?,?,?,?,?,?)").run(s, type, labels[s] ?? "", slot, t.default_interval, now);
        audit(this.db, a.username, a.role, "sensor.add", { serial: s, type, slot, interval: t.default_interval });
      }
    })();
    return uniq;
  }
  update(a: Actor, serial: string, b: { label?: string; zone_id?: number | null; interval?: number }) {
    const s = this.get(serial); if (!s || s.replaced_by) throw new HttpError(404, "sensor not found");
    if (b.label !== undefined) this.db.prepare("UPDATE sensors SET label=? WHERE serial=?").run(String(b.label).slice(0, 60), serial);
    if (b.zone_id !== undefined) this.assignZone(a, serial, b.zone_id);
    if (b.interval !== undefined) {
      const v = Number(b.interval), ci = this.map.types[s.type].config.interval;
      if (!this.intervalOk(s.type, v)) throw bad(`interval must be a whole number of ${ci.unit} from ${ci.min} to ${ci.max}`);
      this.db.prepare("UPDATE sensors SET reporting_interval=? WHERE serial=?").run(v, serial);
    }
    audit(this.db, a.username, a.role, "sensor.update", { serial, ...b });
  }
  remove(a: Actor, serial: string) {
    const s = this.get(serial); if (!s) throw new HttpError(404, "sensor not found");
    this.db.transaction(() => {
      if (s.sent_slot !== null) this.db.prepare("INSERT OR REPLACE INTO pending_removals(type,serial,slot) VALUES(?,?,?)").run(s.type, serial, s.sent_slot);
      this.db.prepare("DELETE FROM points WHERE serial=?").run(serial); this.db.prepare("DELETE FROM sensors WHERE serial=?").run(serial);
      audit(this.db, a.username, a.role, "sensor.remove", { serial, type: s.type, slot: s.slot, in_gateway: s.sent_slot !== null });
    })();
  }
  /** Replace a sensor (same type): label, zone, alarm thresholds, slot and points move; history stays on the old serial; calibration does NOT transfer. */
  replace(a: Actor, oldSerial: string, newSerialRaw: string) {
    const o = this.get(oldSerial); if (!o || o.replaced_by) throw new HttpError(404, "sensor not found"); const n = this.validSerial(newSerialRaw); if (this.get(n)) throw bad(`serial ${n} already exists`);
    this.db.transaction(() => {
      this.db.prepare("UPDATE sensors SET replaced_by=?, slot=NULL, zone_id=NULL WHERE serial=?").run(n, oldSerial);
      this.db.prepare("INSERT INTO sensors(serial,type,label,zone_id,slot,reporting_interval,created_at,thresholds) VALUES(?,?,?,?,?,?,?,?)").run(n, o.type, o.label, o.zone_id, o.slot, o.reporting_interval, Date.now(), o.thresholds);
      this.db.prepare("UPDATE points SET serial=? WHERE serial=?").run(n, oldSerial);
      if (o.sent_slot !== null) this.db.prepare("INSERT OR REPLACE INTO pending_removals(type,serial,slot) VALUES(?,?,?)").run(o.type, oldSerial, o.sent_slot);
      audit(this.db, a.username, a.role, "sensor.replace", { old: oldSerial, new: n, calibration_transferred: false });
    })();
    return n;
  }

  // ---- zones and points ----
  zones() { return this.db.prepare("SELECT * FROM zones ORDER BY sort, id").all() as { id: number; name: string; type: string; sort: number }[]; }
  addZone(a: Actor, name: string, type: string) {
    if (!name?.trim() || name.length > 60) throw bad("zone name 1-60 characters");
    if (!["climate", "soil", "water_storage", "irrigation", "custom"].includes(type)) throw bad("zone type must be climate, soil, water_storage, irrigation or custom");
    try { const r = this.db.prepare("INSERT INTO zones(name,type,sort) VALUES(?,?,(SELECT COALESCE(MAX(sort),0)+1 FROM zones))").run(name.trim(), type); audit(this.db, a.username, a.role, "zone.add", { name, type }); return Number(r.lastInsertRowid); }
    catch { throw bad("a zone with this name already exists"); }
  }
  updateZone(a: Actor, id: number, b: { name?: string; type?: string }) {
    const z = this.db.prepare("SELECT * FROM zones WHERE id=?").get(id) as any; if (!z) throw new HttpError(404, "zone not found");
    const name = b.name?.trim() ?? z.name, type = b.type ?? z.type; if (!name || name.length > 60) throw bad("zone name 1-60 characters");
    if (!["climate", "soil", "water_storage", "irrigation", "custom"].includes(type)) throw bad("bad zone type");
    try { this.db.prepare("UPDATE zones SET name=?,type=? WHERE id=?").run(name, type, id); } catch { throw bad("a zone with this name already exists"); }
    audit(this.db, a.username, a.role, "zone.update", { id, name, type });
  }
  removeZone(a: Actor, id: number) { this.db.prepare("UPDATE sensors SET zone_id=NULL WHERE zone_id=?").run(id); this.db.prepare("DELETE FROM zones WHERE id=?").run(id); audit(this.db, a.username, a.role, "zone.remove", { id }); }
  points(zoneId?: number) { return (zoneId ? this.db.prepare("SELECT * FROM points WHERE zone_id=? ORDER BY id").all(zoneId) : this.db.prepare("SELECT * FROM points ORDER BY id").all()) as { id: number; zone_id: number; serial: string; metric: string; role: string; unit: string }[]; }
  /** Putting a sensor into a zone creates its points (every calibrated metric, e.g. temperature + humidity). Null = out of any zone. */
  assignZone(a: Actor, serial: string, zoneId: number | null) {
    const s = this.get(serial); if (!s) throw new HttpError(404, "sensor not found");
    if (zoneId !== null && !this.db.prepare("SELECT 1 FROM zones WHERE id=?").get(zoneId)) throw new HttpError(404, "zone not found");
    this.db.transaction(() => {
      this.db.prepare("UPDATE sensors SET zone_id=? WHERE serial=?").run(zoneId, serial); this.db.prepare("DELETE FROM points WHERE serial=?").run(serial);
      if (zoneId !== null) for (const [m, f] of Object.entries(this.map.types[s.type].data.fields)) if (f.calibrated) this.db.prepare("INSERT INTO points(zone_id,serial,metric,role,unit) VALUES(?,?,?,?,?)").run(zoneId, serial, m, m === "temperature" ? "Air temperature" : m === "humidity" ? "Air humidity" : m, f.unit);
      audit(this.db, a.username, a.role, "sensor.zone", { serial, zone_id: zoneId });
    })();
  }
  removePoint(a: Actor, id: number) { this.db.prepare("DELETE FROM points WHERE id=?").run(id); audit(this.db, a.username, a.role, "point.remove", { id }); }
  setPointRole(a: Actor, id: number, role: string) { this.db.prepare("UPDATE points SET role=? WHERE id=?").run(String(role).slice(0, 40), id); audit(this.db, a.username, a.role, "point.update", { id, role }); }

  // ---- calibration ----
  activeCals(): Map<string, Cal> { const m = new Map<string, Cal>(); for (const r of this.db.prepare("SELECT serial,metric,offset,gain FROM calibrations WHERE active=1").all() as any[]) m.set(`${r.serial}|${r.metric}`, { offset: r.offset, gain: r.gain }); return m; }
  calRow(serial: string, metric: string) { return this.db.prepare("SELECT * FROM calibrations WHERE serial=? AND metric=? AND active=1").get(serial, metric) as any; }
  calHistory(serial: string) { return this.db.prepare("SELECT * FROM calibrations WHERE serial=? ORDER BY calibrated_at DESC, id DESC").all(serial) as any[]; }
  calibrate(a: Actor, serial: string, b: { metric: string; method: "offset" | "two_point" | "manual"; raw?: number; reference?: number; raw2?: number; reference2?: number; offset?: number; gain?: number; notes?: string; dueAt?: number | null; confirmOutOfLimits?: boolean }) {
    const s = this.get(serial); if (!s) throw new HttpError(404, "sensor not found"); const f = this.map.types[s.type].data.fields[b.metric];
    if (!f?.calibrated) throw bad("this metric cannot be calibrated"); const num = (v: unknown, n: string) => { if (typeof v !== "number" || !Number.isFinite(v)) throw bad(n + " must be a number"); return v; };
    let cal: Cal;
    if (b.method === "offset") cal = offsetCal(num(b.raw, "raw"), num(b.reference, "reference"));
    else if (b.method === "two_point") { try { cal = twoPointCal(num(b.raw, "raw"), num(b.reference, "reference"), num(b.raw2, "raw2"), num(b.reference2, "reference2")); } catch (e: any) { throw bad(e.message); } }
    else if (b.method === "manual") cal = { offset: num(b.offset, "offset"), gain: b.gain === undefined ? 1 : num(b.gain, "gain") };
    else throw bad("method must be offset, two_point or manual");
    const viol = checkLimits(cal, this.limits()[b.metric] ?? DEFAULT_LIMITS.temperature);
    if (viol.length && !b.confirmOutOfLimits) throw new HttpError(409, "correction is outside the allowed limits", { violations: viol, cal, needsConfirm: true });
    this.db.transaction(() => {
      const old = this.calRow(serial, b.metric); this.db.prepare("UPDATE calibrations SET active=0 WHERE serial=? AND metric=? AND active=1").run(serial, b.metric);
      this.db.prepare("INSERT INTO calibrations(serial,metric,offset,gain,method,notes,calibrated_at,calibrated_by,due_at,active,check_sensor) VALUES(?,?,?,?,?,?,?,?,?,1,?)")
        .run(serial, b.metric, cal.offset, cal.gain, b.method, b.notes ?? null, Date.now(), a.username, b.dueAt ?? null, viol.length ? 1 : 0);
      audit(this.db, a.username, a.role, "calibration.set", { serial, metric: b.metric, method: b.method, old: old ? { offset: old.offset, gain: old.gain } : null, new: cal, out_of_limits: viol });
    })();
    return cal;
  }
  resetCal(a: Actor, serial: string, metric: string) {
    const old = this.calRow(serial, metric); if (!old) throw bad("no active calibration to reset");
    this.db.transaction(() => { this.db.prepare("UPDATE calibrations SET active=0 WHERE serial=? AND metric=? AND active=1").run(serial, metric);
      this.db.prepare("INSERT INTO calibrations(serial,metric,offset,gain,method,notes,calibrated_at,calibrated_by,active) VALUES(?,?,0,1,'reset','reset to raw',?,?,0)").run(serial, metric, Date.now(), a.username);
      audit(this.db, a.username, a.role, "calibration.reset", { serial, metric, old: { offset: old.offset, gain: old.gain } }); })();
  }
  setCalDue(a: Actor, serial: string, metric: string, dueAt: number | null) {
    const r = this.calRow(serial, metric); if (!r) throw bad("sensor has no active calibration"); this.db.prepare("UPDATE calibrations SET due_at=? WHERE id=?").run(dueAt, r.id); audit(this.db, a.username, a.role, "calibration.due", { serial, metric, dueAt });
  }

  // ---- backup / restore ----
  exportAll() {
    const d = this.db; return { format: "farmpilot-core-backup", version: 3, map_version: this.map.map_version, exported_at: Date.now(),
      sensors: d.prepare("SELECT serial,type,label,zone_id,slot,reporting_interval,created_at,replaced_by,thresholds FROM sensors").all(), calibrations: d.prepare("SELECT * FROM calibrations").all(),
      zones: d.prepare("SELECT * FROM zones").all(), points: d.prepare("SELECT * FROM points").all(), settings: (d.prepare("SELECT key,value FROM settings WHERE key LIKE 'gw.%' OR key LIKE 'cal.%'").all()) };
  }
  restore(a: Actor, b: any) {
    if (!b || b.format !== "farmpilot-core-backup" || b.version !== 3) throw bad(b?.format === "farmpilot-core-backup" ? "backup from an older build (hex serials, intervals in seconds): re-enter the sensors, it cannot be restored as is" : "not a Farm-Pilot CORE backup file");
    for (const k of ["sensors", "calibrations", "zones", "points", "settings"]) if (!Array.isArray(b[k])) throw bad(`backup is missing "${k}"`);
    const seen = new Set<string>(), slots = new Set<string>();
    for (const s of b.sensors) {
      if (typeof s.serial !== "string" || !this.map.serial_pattern.test(s.serial) || seen.has(s.serial)) throw bad(`backup has an invalid or duplicate serial: ${String(s.serial)}`); seen.add(s.serial);
      const t = this.map.types[s.type]; if (!t) throw bad(`backup has an unknown sensor type: ${s.type}`);
      if (s.slot !== null && !s.replaced_by) { if (!Number.isInteger(s.slot) || s.slot < 1 || s.slot > t.groups) throw bad(`slot out of range for ${s.serial}`); const k = `${s.type}:${s.slot}`; if (slots.has(k)) throw bad(`two sensors share slot ${k}`); slots.add(k); }
      if (!Number.isInteger(s.reporting_interval) || s.reporting_interval < t.config.interval.min || s.reporting_interval > t.config.interval.max) throw bad(`interval out of range for ${s.serial}`);
    }
    for (const s of b.settings) if (typeof s.key !== "string" || !/^(gw|cal)\./.test(s.key) || typeof s.value !== "string") throw bad("backup has an invalid setting");
    const d = this.db;
    d.transaction(() => {
      d.prepare("DELETE FROM points").run(); d.prepare("DELETE FROM calibrations").run(); d.prepare("DELETE FROM sensors").run(); d.prepare("DELETE FROM pending_removals").run(); d.prepare("DELETE FROM zones").run();
      for (const z of b.zones) d.prepare("INSERT INTO zones(id,name,type,sort) VALUES(?,?,?,?)").run(z.id, z.name, z.type, z.sort ?? 0);
      // sent_slot/sent_interval start empty: after a restore every sensor shows NOT SENT until "Send to Gateway" has pushed it.
      for (const s of b.sensors) d.prepare("INSERT INTO sensors(serial,type,label,zone_id,slot,reporting_interval,created_at,replaced_by,thresholds) VALUES(?,?,?,?,?,?,?,?,?)").run(s.serial, s.type, s.label ?? "", s.zone_id ?? null, s.slot ?? null, s.reporting_interval, s.created_at ?? Date.now(), s.replaced_by ?? null, s.thresholds ?? null);
      for (const c of b.calibrations) d.prepare("INSERT INTO calibrations(serial,metric,offset,gain,method,notes,calibrated_at,calibrated_by,due_at,active,check_sensor) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(c.serial, c.metric, c.offset, c.gain, c.method, c.notes ?? null, c.calibrated_at, c.calibrated_by, c.due_at ?? null, c.active ? 1 : 0, c.check_sensor ? 1 : 0);
      for (const p of b.points) d.prepare("INSERT INTO points(zone_id,serial,metric,role,unit) VALUES(?,?,?,?,?)").run(p.zone_id, p.serial, p.metric, p.role, p.unit ?? "");
      d.prepare("DELETE FROM settings WHERE key LIKE 'gw.%' OR key LIKE 'cal.%'").run(); for (const s of b.settings) setSetting(d, s.key, s.value);
      audit(d, a.username, a.role, "backup.restore", { sensors: b.sensors.length, zones: b.zones.length, calibrations: b.calibrations.length });
    })();
  }
}
export { applyCal };
