// Farm Profile and contacts: validation, storage, audit (old and new values), logo handling, backup parts. Pure SQLite, no HTTP.
import { createHash } from "node:crypto";
import { config } from "../config.js";
import { audit, getSetting, setSetting, type Db } from "../db.js";
import type { RegMap } from "../drivers/modbus/regmap.js";
import { HttpError, type Actor } from "./registry.js";

export const DATE_FORMATS = ["D Mon YYYY", "YYYY-MM-DD", "DD/MM/YYYY", "MM/DD/YYYY"];
export const LOGO_MAX = 256 * 1024;
export const CONTACT_KINDS = ["gateway_offline", "no_update", "low_battery", "calibration_due"] as const;
const FIELDS = ["farm_name", "site_name", "owner_name", "notes", "address", "latitude", "longitude", "timezone", "language", "temperature_unit", "date_format", "time_format",
  "low_voltage_by_type", "rssi_good", "rssi_weak", "stale_multiplier", "offline_multiplier", "calibration_due_days", "default_theme"] as const;
const fieldErr = (fields: Record<string, string>) => new HttpError(400, "invalid profile: " + Object.entries(fields).map(([k, v]) => `${k} ${v}`).join("; "), { fields });
export const validTimezone = (tz: unknown) => { if (typeof tz !== "string" || !tz) return false; try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; } catch { return false; } };
const boxZone = () => { try { const z = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone; return validTimezone(z) ? z : "UTC"; } catch { return "UTC"; } };
const titleCase = (s: string) => s.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/** Validates the sent fields (partial update) against the current row; returns the columns to write. Unknown fields are rejected, every problem is reported by field. */
export function validateProfile(body: any, cur: any, types: string[]): Record<string, unknown> {
  const e: Record<string, string> = {}, out: Record<string, unknown> = {};
  if (!body || typeof body !== "object" || Array.isArray(body)) throw fieldErr({ body: "must be an object" });
  for (const k of Object.keys(body)) if (!(FIELDS as readonly string[]).includes(k)) e[k] = "is not a known field";
  const str = (k: string, max: number, min = 0) => { const v = body[k]; if (typeof v !== "string") return void (e[k] = "must be text"); const t = v.trim(); if (t.length < min || t.length > max) return void (e[k] = min ? `must be ${min} to ${max} characters` : `must be at most ${max} characters`); out[k] = t; };
  const numOrNull = (k: string, lo: number, hi: number, int = false) => { const v = body[k]; if (v === null || v === "") { out[k] = null; return; } const n = Number(v); if (typeof v === "boolean" || !Number.isFinite(n) || n < lo || n > hi || (int && !Number.isInteger(n))) e[k] = `must be ${int ? "a whole number " : "a number "}from ${lo} to ${hi}, or empty for the default`; else out[k] = n; };
  if ("farm_name" in body) str("farm_name", 60, 1);
  for (const [k, m] of [["site_name", 60], ["owner_name", 80], ["notes", 2000], ["address", 200]] as const) if (k in body) str(k, m);
  if ("latitude" in body) numOrNull("latitude", -90, 90); if ("longitude" in body) numOrNull("longitude", -180, 180);
  if ("timezone" in body && !validTimezone(body.timezone)) e.timezone = "is not an IANA time zone name (for example Asia/Dubai)"; else if ("timezone" in body) out.timezone = body.timezone;
  if ("language" in body) { if (typeof body.language === "string" && /^[a-z]{2}$/.test(body.language)) out.language = body.language; else e.language = "must be a two-letter code such as en"; }
  if ("temperature_unit" in body) { if (body.temperature_unit === "C" || body.temperature_unit === "F") out.temperature_unit = body.temperature_unit; else e.temperature_unit = "must be C or F"; }
  if ("date_format" in body) { if (DATE_FORMATS.includes(body.date_format)) out.date_format = body.date_format; else e.date_format = "must be one of " + DATE_FORMATS.join(", "); }
  if ("time_format" in body) { if (body.time_format === "12" || body.time_format === "24") out.time_format = body.time_format; else e.time_format = "must be 12 or 24"; }
  if ("default_theme" in body) { if (body.default_theme === "light" || body.default_theme === "dark") out.default_theme = body.default_theme; else e.default_theme = "must be light or dark"; }
  if ("rssi_good" in body) numOrNull("rssi_good", -130, 0); if ("rssi_weak" in body) numOrNull("rssi_weak", -130, 0);
  if ("stale_multiplier" in body) numOrNull("stale_multiplier", 1, 20, true); if ("offline_multiplier" in body) numOrNull("offline_multiplier", 1, 20, true);
  if ("calibration_due_days" in body) numOrNull("calibration_due_days", 1, 3650, true);
  if ("low_voltage_by_type" in body) {
    const v = body.low_voltage_by_type, nv: Record<string, number> = {}; let ok = v && typeof v === "object" && !Array.isArray(v);
    if (ok) for (const [t, x] of Object.entries<any>(v)) { if (!types.includes(t)) { e.low_voltage_by_type = `unknown sensor type ${t}`; ok = false; break; } if (x === null || x === "") continue; const n = Number(x); if (!Number.isFinite(n) || n < 0 || n > 10) { e.low_voltage_by_type = `${t}: must be 0 to 10 V`; ok = false; break; } nv[t] = n; }
    else e.low_voltage_by_type = "must be an object of sensor type to volts";
    if (ok) out.low_voltage_by_type = JSON.stringify(nv);
  }
  if (!e.rssi_good && !e.rssi_weak && ("rssi_good" in out || "rssi_weak" in out)) { const g = "rssi_good" in out ? out.rssi_good : cur.rssi_good, w = "rssi_weak" in out ? out.rssi_weak : cur.rssi_weak; if (g !== null && w !== null && (w as number) >= (g as number)) e.rssi_weak = "must be below the good limit"; }
  if (("latitude" in out || "longitude" in out) && !e.latitude && !e.longitude) { const la = "latitude" in out ? out.latitude : cur.latitude, lo = "longitude" in out ? out.longitude : cur.longitude; if ((la === null) !== (lo === null)) e.longitude = "latitude and longitude go together: fill both or neither"; }
  if (Object.keys(e).length) throw fieldErr(e);
  return out;
}

export interface ContactIn { name: string; role: string; phone: string; email: string; notify_gateway_offline: number; notify_no_update: number; notify_low_battery: number; notify_calibration_due: number; sort?: number; }
export function validateContact(b: any): ContactIn {
  const e: Record<string, string> = {}; if (!b || typeof b !== "object") throw fieldErr({ body: "must be an object" });
  const t = (k: string, max: number) => (typeof b[k] === "string" ? b[k].trim().slice(0, max + 1) : b[k] === undefined || b[k] === null ? "" : (e[k] = "must be text", ""));
  const name = t("name", 80), role = t("role", 60), phone = t("phone", 30), email = t("email", 120);
  if (!name || name.length > 80) e.name = "is required, at most 80 characters"; if (role.length > 60) e.role = "is at most 60 characters"; if (phone.length > 30 || (phone && !/^[+0-9 ()-]{5,30}$/.test(phone))) e.phone = "is not a phone number";
  if (email && (email.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) e.email = "is not an email address"; if (!phone && !email) e.phone = "or an email is required";
  const flag = (k: string) => (b[k] === undefined ? 0 : b[k] === true || b[k] === 1 ? 1 : b[k] === false || b[k] === 0 ? 0 : (e[k] = "must be true or false", 0));
  const f = { notify_gateway_offline: flag("notify_gateway_offline"), notify_no_update: flag("notify_no_update"), notify_low_battery: flag("notify_low_battery"), notify_calibration_due: flag("notify_calibration_due") };
  const sort = b.sort === undefined ? undefined : Number.isInteger(b.sort) ? b.sort : (e.sort = "must be a whole number", 0);
  if (Object.keys(e).length) throw fieldErr(e);
  return { name, role, phone, email, ...f, sort };
}

/** PNG (magic bytes) or SVG (parsed as text, active content refused). Returns the content type. SVG is only ever served as an image with a sandboxing CSP, never inlined. */
export function checkLogo(buf: Buffer, declared: string): string {
  if (!buf.length) throw new HttpError(400, "logo file is empty"); if (buf.length > LOGO_MAX) throw new HttpError(413, `logo is larger than ${LOGO_MAX / 1024} KB`);
  if (declared === "image/png") { if (buf.length < 8 || !buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) throw new HttpError(400, "file is not a PNG image"); return "image/png"; }
  if (declared === "image/svg+xml") {
    const t = buf.toString("utf8"); if (!/<svg[\s>]/i.test(t)) throw new HttpError(400, "file is not an SVG image");
    if (/<script|<foreignObject|<iframe|<object|<embed|\son\w+\s*=|javascript:|data:text\/html|(?:xlink:)?href\s*=\s*["']\s*(?:https?:|\/\/)|<!ENTITY/i.test(t)) throw new HttpError(400, "SVG contains scripts or external references and was refused");
    return "image/svg+xml";
  }
  throw new HttpError(415, "logo must be a PNG or SVG image");
}

export class ProfileService {
  now = () => Date.now();
  constructor(private db: Db, private map: RegMap | null) { this.ensure(); }
  private ensure() {
    if (this.db.prepare("SELECT 1 FROM farm_profile WHERE id=1").get()) return;
    this.db.prepare("INSERT INTO farm_profile(id,farm_name,site_name,timezone) VALUES(1,?,?,?)").run(titleCase(config.farm) || "My Farm", "", boxZone());
  }
  private row(): any { this.ensure(); return this.db.prepare("SELECT * FROM farm_profile WHERE id=1").get(); }
  private types() { return this.map ? Object.keys(this.map.types) : []; }
  private shape(r: any) {
    const { logo, logo_type, logo_hash, ...rest } = r; let lv = {}; try { lv = JSON.parse(r.low_voltage_by_type); } catch { /* keep {} */ }
    return { ...rest, low_voltage_by_type: lv, has_logo: !!logo, logo_hash: logo_hash ?? null, logo_url: logo ? `/api/farm-profile/logo?v=${logo_hash}` : null,
      placeholder: r.updated_by === null, timezone_confirm_needed: getSetting(this.db, "profile.tz_confirm", "0") === "1",
      defaults: { rssi_good: this.map?.health.rssi_good_above ?? -90, rssi_weak: this.map?.health.rssi_poor_below ?? -105, stale_multiplier: this.map?.health.offline_multiplier ?? 3, offline_multiplier: this.map?.health.offline_multiplier ?? 3,
        low_voltage_by_type: Object.fromEntries(Object.values(this.map?.types ?? {}).filter((t) => t.enabled).map((t) => [t.key, t.low_voltage])) },
      types: Object.values(this.map?.types ?? {}).filter((t) => t.enabled).map((t) => ({ key: t.key, label: t.label })) };
  }
  get() { return this.shape(this.row()); }
  /** What any logged-in user may read: header, SCADA View formatting. No address, GPS, owner, notes, thresholds. */
  publicInfo() { const r = this.row(); return { farm_name: r.farm_name, site_name: r.site_name || r.farm_name, timezone: r.timezone, temperature_unit: r.temperature_unit, date_format: r.date_format, time_format: r.time_format, default_theme: r.default_theme, logo_url: r.logo ? `/api/farm-profile/logo?v=${r.logo_hash}` : null }; }
  farmName(): string { return this.row().farm_name; }
  update(a: Actor, body: any) {
    const cur = this.row(), out = validateProfile(body, cur, this.types()); const keys = Object.keys(out);
    if (!keys.length) return this.get();
    const old: Record<string, unknown> = {}, nw: Record<string, unknown> = {}; for (const k of keys) { old[k] = cur[k]; nw[k] = out[k]; }
    this.db.transaction(() => {
      this.db.prepare(`UPDATE farm_profile SET ${keys.map((k) => `${k}=?`).join(",")}, updated_at=?, updated_by=? WHERE id=1`).run(...keys.map((k) => out[k] as any), this.now(), a.username);
      if ("timezone" in out) setSetting(this.db, "profile.tz_confirm", "0");                           // the Admin has seen and saved the zone
      audit(this.db, a.username, a.role, "farm_profile.update", { old, new: nw });
    })();
    return this.get();
  }
  logo(): { type: string; data: Buffer } | null { const r = this.row(); return r.logo ? { type: r.logo_type, data: r.logo } : null; }
  setLogo(a: Actor, buf: Buffer, declared: string) {
    const type = checkLogo(buf, declared), hash = createHash("sha256").update(buf).digest("hex"); const old = this.row().logo_hash ?? null;
    this.db.prepare("UPDATE farm_profile SET logo=?,logo_type=?,logo_hash=?,updated_at=?,updated_by=? WHERE id=1").run(buf, type, hash, this.now(), a.username);
    audit(this.db, a.username, a.role, "farm_profile.logo", { old_hash: old, new_hash: hash, type, bytes: buf.length }); return this.get();
  }
  deleteLogo(a: Actor) { const old = this.row().logo_hash ?? null; this.db.prepare("UPDATE farm_profile SET logo=NULL,logo_type=NULL,logo_hash=NULL,updated_at=?,updated_by=? WHERE id=1").run(this.now(), a.username); audit(this.db, a.username, a.role, "farm_profile.logo", { old_hash: old, new_hash: null }); return this.get(); }

  // ---- contacts (stored and shown only; CORE sends nothing in this milestone) ----
  contacts() { return this.db.prepare("SELECT * FROM farm_contacts ORDER BY sort, id").all(); }
  addContact(a: Actor, b: any) {
    const c = validateContact(b); const sort = c.sort ?? ((this.db.prepare("SELECT COALESCE(MAX(sort),0)+1 n FROM farm_contacts").get() as { n: number }).n);
    const id = Number(this.db.prepare("INSERT INTO farm_contacts(name,role,phone,email,notify_gateway_offline,notify_no_update,notify_low_battery,notify_calibration_due,sort,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(c.name, c.role, c.phone, c.email, c.notify_gateway_offline, c.notify_no_update, c.notify_low_battery, c.notify_calibration_due, sort, this.now()).lastInsertRowid);
    audit(this.db, a.username, a.role, "farm_contact.add", { id, new: c }); return this.db.prepare("SELECT * FROM farm_contacts WHERE id=?").get(id);
  }
  updateContact(a: Actor, id: number, b: any) {
    const cur = this.db.prepare("SELECT * FROM farm_contacts WHERE id=?").get(id) as any; if (!cur) throw new HttpError(404, "contact not found");
    const c = validateContact({ ...cur, ...b }); this.db.prepare("UPDATE farm_contacts SET name=?,role=?,phone=?,email=?,notify_gateway_offline=?,notify_no_update=?,notify_low_battery=?,notify_calibration_due=?,sort=? WHERE id=?")
      .run(c.name, c.role, c.phone, c.email, c.notify_gateway_offline, c.notify_no_update, c.notify_low_battery, c.notify_calibration_due, c.sort ?? cur.sort, id);
    audit(this.db, a.username, a.role, "farm_contact.update", { id, old: cur, new: c }); return this.db.prepare("SELECT * FROM farm_contacts WHERE id=?").get(id);
  }
  deleteContact(a: Actor, id: number) { const cur = this.db.prepare("SELECT * FROM farm_contacts WHERE id=?").get(id); if (!cur) throw new HttpError(404, "contact not found"); this.db.prepare("DELETE FROM farm_contacts WHERE id=?").run(id); audit(this.db, a.username, a.role, "farm_contact.delete", { id, old: cur }); }
  /** Who to inform, per alarm kind: name, role and phone of the flagged contacts only. No email, no ids. */
  alarmView(): Record<string, { name: string; role: string; phone: string }[]> {
    const out: Record<string, { name: string; role: string; phone: string }[]> = {};
    for (const k of CONTACT_KINDS) out[k] = (this.db.prepare(`SELECT name,role,phone FROM farm_contacts WHERE notify_${k}=1 ORDER BY sort,id`).all() as any[]);
    return out;
  }

  // ---- backup parts ----
  exportParts() { const r = this.row(); return { farm_profile: { ...this.shape(r), logo_base64: r.logo ? Buffer.from(r.logo).toString("base64") : null, logo_type: r.logo_type ?? null, defaults: undefined, types: undefined, has_logo: undefined, logo_url: undefined, placeholder: undefined, timezone_confirm_needed: undefined }, farm_contacts: this.contacts() }; }
  /** Validates the profile and contacts of a backup like the live API would. Throws before anything is changed. */
  checkBackup(b: any) {
    if (b.farm_profile === undefined && b.farm_contacts === undefined) return;
    if (b.farm_profile !== undefined) {
      if (!b.farm_profile || typeof b.farm_profile !== "object") throw new HttpError(400, "backup farm_profile is invalid");
      const { id, updated_at, updated_by, logo_base64, logo_type, logo_hash, ...fields } = b.farm_profile; validateProfile(fields, this.row(), this.types());
      if (logo_base64) { const buf = Buffer.from(String(logo_base64), "base64"); checkLogo(buf, String(logo_type)); }
    }
    if (b.farm_contacts !== undefined) { if (!Array.isArray(b.farm_contacts)) throw new HttpError(400, "backup farm_contacts is invalid"); for (const c of b.farm_contacts) validateContact(c); }
  }
  restoreParts(a: Actor, b: any) {
    if (b.farm_profile === undefined && b.farm_contacts === undefined) return;
    this.db.transaction(() => {
      if (b.farm_profile) {
        const { id, updated_at, updated_by, logo_base64, logo_type, logo_hash, has_logo, ...fields } = b.farm_profile; const out = validateProfile(fields, this.row(), this.types()); const keys = Object.keys(out);
        if (keys.length) this.db.prepare(`UPDATE farm_profile SET ${keys.map((k) => `${k}=?`).join(",")} WHERE id=1`).run(...keys.map((k) => out[k] as any));
        if (logo_base64) { const buf = Buffer.from(String(logo_base64), "base64"); const t = checkLogo(buf, String(logo_type)); this.db.prepare("UPDATE farm_profile SET logo=?,logo_type=?,logo_hash=? WHERE id=1").run(buf, t, createHash("sha256").update(buf).digest("hex")); }
        else this.db.prepare("UPDATE farm_profile SET logo=NULL,logo_type=NULL,logo_hash=NULL WHERE id=1").run();
        this.db.prepare("UPDATE farm_profile SET updated_at=?, updated_by=? WHERE id=1").run(this.now(), a.username);
        setSetting(this.db, "profile.tz_confirm", "1");                                                 // the box zone may differ: the Admin must confirm it
      }
      if (b.farm_contacts) { this.db.prepare("DELETE FROM farm_contacts").run(); for (const [i, c] of (b.farm_contacts as any[]).entries()) { const v = validateContact(c); this.db.prepare("INSERT INTO farm_contacts(name,role,phone,email,notify_gateway_offline,notify_no_update,notify_low_battery,notify_calibration_due,sort,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(v.name, v.role, v.phone, v.email, v.notify_gateway_offline, v.notify_no_update, v.notify_low_battery, v.notify_calibration_due, v.sort ?? i, this.now()); } }
      audit(this.db, a.username, a.role, "farm_profile.restore", { profile: !!b.farm_profile, contacts: b.farm_contacts?.length ?? null });
    })();
  }
}
