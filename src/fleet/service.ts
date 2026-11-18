// 2026-11-19 -- Connected Boxes (Online build): storage, enrolment, report intake, status history. No HTTP in this file; routes.ts is the only caller besides the tests.
// RULES: the access key is stored as a SHA-256 hash only (it is 256 random bits, so a fast hash is enough) and shown to the box once, in the enrolment answer.
// The latest report is kept (sanitised, never the raw body); everything else about the past is the status-change events and one availability record per hour, for 30 days (nightly prune).
// Nothing here talks to a box: there is no command, no configuration and no remote access from the server to a box.
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { Db } from "../db.js";
import { audit } from "../db.js";
import { DEVICE_ID_RE } from "../licence/device.js";
import { DAY, HISTORY_DAYS, HOUR, boxStatus, clampInterval, dayStart, hourStart, lateAt, offlineAt, type BoxStatus } from "./status.js";

export const SCHEMA_FLEET = `
CREATE TABLE IF NOT EXISTS fleet_boxes (
  id INTEGER PRIMARY KEY, device_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL CHECK (state IN ('pending','approved','rejected','revoked')),
  reported_name TEXT NOT NULL DEFAULT '', display_name TEXT, key_hash TEXT, key_issued_at INTEGER,
  requested_at INTEGER, first_enrolled_at INTEGER, first_report_at INTEGER, last_report_at INTEGER, interval_s INTEGER NOT NULL DEFAULT 60,
  last_report TEXT,                       -- the LATEST report only, sanitised field by field (parseReport); older ones are not kept
  last_status TEXT, report_count INTEGER NOT NULL DEFAULT 0, auth_failures INTEGER NOT NULL DEFAULT 0, last_auth_failure_at INTEGER, version TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS fleet_codes (
  id INTEGER PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, hint TEXT NOT NULL, note TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER, used_by TEXT, created_by TEXT);
-- 30-day history (no foreign keys on purpose: it must survive a revoke and any later change of the box row)
CREATE TABLE IF NOT EXISTS fleet_events (id INTEGER PRIMARY KEY, device_id TEXT NOT NULL, ts INTEGER NOT NULL, status TEXT NOT NULL, note TEXT);
CREATE INDEX IF NOT EXISTS idx_fleet_events ON fleet_events(device_id, ts);
CREATE TABLE IF NOT EXISTS fleet_hours (device_id TEXT NOT NULL, hour_ts INTEGER NOT NULL, expected INTEGER NOT NULL DEFAULT 0, received INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (device_id, hour_ts)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_fleet_hours_ts ON fleet_hours(hour_ts);`;

export const CODE_HOURS = 24;
export const REPORT_GAP_MS = 10_000;                        // not more than 1 report per 10 s per Device ID
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";   // no 0/O/1/I
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const normCode = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, "");
const clip = (v: unknown, n: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, n) : "");
const nint = (v: unknown, max = 1e12) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(Math.round(v), max) : null);
const lim = (v: unknown) => (v === null ? null : nint(v));
const isoOrNull = (v: unknown) => { if (typeof v !== "string") return null; const t = Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString() : null; };

export interface Bad extends Error { status: number }
export const bad = (status: number, message: string): Bad => Object.assign(new Error(message), { status });

export interface StoredReport { box_name: string; report_no: number | null; interval_s: number; version: string; build: string; os: string; runs_as: string | null; uptime_s: number | null;
  licence: { type: string; valid_until: string | null; state: string }; usage: { data_sources: { n: number | null; max: number | null }; sensors: { n: number | null; max: number | null } }; last_data_at: string | null; active_alarms: number | null; }
/** Field-by-field copy: unknown fields are ignored (so version 2 boxes still work) and nothing from the body is stored that is not listed here. */
export function parseReport(b: any): StoredReport {
  if (!b || typeof b !== "object" || b.v !== 1) throw bad(400, "report version 1 expected");
  const l = b.licence ?? {}, u = b.usage ?? {}, ds = u.data_sources ?? {}, se = u.sensors ?? {};
  return { box_name: clip(b.box_name, 64), report_no: nint(b.report_no), interval_s: clampInterval(b.interval_s), version: clip(b.version, 32), build: clip(b.build, 40), os: clip(b.os, 120),
    runs_as: ["service", "console", "systemd"].includes(b.runs_as) ? b.runs_as : null, uptime_s: nint(b.uptime_s),
    licence: { type: clip(l.type, 24) || "FREE", valid_until: isoOrNull(l.valid_until), state: ["LICENSED", "FREE", "EXPIRED", "INVALID"].includes(l.state) ? l.state : "FREE" },
    usage: { data_sources: { n: nint(ds.n), max: lim(ds.max) }, sensors: { n: nint(se.n), max: lim(se.max) } }, last_data_at: isoOrNull(b.last_data_at), active_alarms: nint(b.active_alarms) };
}
export interface BoxRow { id: number; device_id: string; state: "pending" | "approved" | "rejected" | "revoked"; reported_name: string; display_name: string | null; key_hash: string | null; key_issued_at: number | null; requested_at: number | null; first_enrolled_at: number | null;
  first_report_at: number | null; last_report_at: number | null; interval_s: number; last_report: string | null; last_status: string | null; report_count: number; auth_failures: number; last_auth_failure_at: number | null; version: string | null; created_at: number; }

export class FleetService {
  private lastAccepted = new Map<string, number>(); private ipFails = new Map<string, { n: number; t: number }>(); private unknownFails = new Map<string, number>();
  constructor(private db: Db, private now: () => number = Date.now) { db.exec(SCHEMA_FLEET); }
  box(deviceId: string) { return this.db.prepare("SELECT * FROM fleet_boxes WHERE device_id=?").get(deviceId) as BoxRow | undefined; }
  boxById(id: unknown) { return this.db.prepare("SELECT * FROM fleet_boxes WHERE id=?").get(Number(id)) as BoxRow | undefined; }
  private boxAudit(deviceId: string, action: string, detail: unknown) { audit(this.db, "box:" + deviceId, "box", action, detail); }
  private event(deviceId: string, ts: number, status: string, note?: string) { this.db.prepare("INSERT INTO fleet_events(device_id,ts,status,note) VALUES(?,?,?,?)").run(deviceId, ts, status, note ?? null); }

  // ---------- abuse limits (in memory: a restart resets them, which is fine for a 10 s / 1 min window) ----------
  ipLimited(ip: string, t = this.now()): boolean { const f = this.ipFails.get(ip); return !!f && t - f.t < 60_000 && f.n >= 30; }
  private noteIpFail(ip: string, t: number) { const f = this.ipFails.get(ip); if (!f || t - f.t >= 60_000) this.ipFails.set(ip, { n: 1, t }); else f.n++; if (this.ipFails.size > 5000) for (const [k, v] of this.ipFails) if (t - v.t > 60_000) this.ipFails.delete(k); }

  // ---------- codes ----------
  createCode(by: string, note?: string): { code: string; expires_at: number } {
    let raw = ""; for (let i = 0; i < 8; i++) raw += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    const t = this.now(), exp = t + CODE_HOURS * HOUR, shown = raw.slice(0, 4) + "-" + raw.slice(4);
    this.db.prepare("INSERT INTO fleet_codes(code_hash,hint,note,created_at,expires_at,created_by) VALUES(?,?,?,?,?,?)").run(sha256(raw), raw.slice(-3), clip(note, 80) || null, t, exp, by);
    audit(this.db, by, "admin", "fleet.code_created", { hint: raw.slice(-3), expires_at: new Date(exp).toISOString() });
    return { code: shown, expires_at: exp };            // the only time the code exists in plain text
  }
  openCodes() { const t = this.now(); return this.db.prepare("SELECT id,hint,note,created_at,expires_at FROM fleet_codes WHERE used_at IS NULL AND expires_at>? ORDER BY created_at DESC").all(t) as { id: number; hint: string; note: string | null; created_at: number; expires_at: number }[]; }

  // ---------- enrolment (public route) ----------
  enrol(ip: string, b: any): { http: 200 | 202; body: any } {
    const t = this.now(), id = typeof b?.device_id === "string" ? b.device_id.trim().toUpperCase() : "";
    if (!DEVICE_ID_RE.test(id)) throw bad(400, "Device ID must look like FP-XXXX-XXXX-XXXX");
    if (this.ipLimited(ip, t)) throw bad(429, "too many attempts");
    const name = clip(b.name, 64) || id, version = clip(b.version, 32), code = typeof b.code === "string" ? normCode(b.code) : "";
    const row = this.box(id);
    if (code) {
      if (code.length < 6 || code.length > 20) { this.noteIpFail(ip, t); throw bad(403, "enrolment code not valid or expired"); }
      const key = randomBytes(32).toString("base64url");
      const ok = this.db.transaction(() => {
        const c = this.db.prepare("SELECT id FROM fleet_codes WHERE code_hash=? AND used_at IS NULL AND expires_at>?").get(sha256(code), t) as { id: number } | undefined;
        if (!c) return false;
        this.db.prepare("UPDATE fleet_codes SET used_at=?, used_by=? WHERE id=?").run(t, id, c.id);
        if (row) this.db.prepare("UPDATE fleet_boxes SET state='approved', key_hash=?, key_issued_at=?, reported_name=?, version=?, first_enrolled_at=COALESCE(first_enrolled_at,?), auth_failures=0 WHERE id=?").run(sha256(key), t, name, version, t, row.id);
        else this.db.prepare("INSERT INTO fleet_boxes(device_id,state,reported_name,key_hash,key_issued_at,first_enrolled_at,version,created_at) VALUES(?,'approved',?,?,?,?,?,?)").run(id, name, sha256(key), t, t, version, t);
        this.boxAudit(id, "fleet.enrol", { via: "code", rekeyed: !!row?.key_hash }); return true;
      })();
      if (!ok) { this.noteIpFail(ip, t); throw bad(403, "enrolment code not valid or expired"); }       // wrong, expired and already used look the same on purpose
      return { http: 200, body: { ok: true, status: "approved", access_key: key, server_time: new Date(t).toISOString() } };
    }
    // no code: the box asks to be approved by an Admin
    if (!row) { this.db.prepare("INSERT INTO fleet_boxes(device_id,state,reported_name,requested_at,version,created_at) VALUES(?,'pending',?,?,?,?)").run(id, name, t, version, t); this.boxAudit(id, "fleet.enrol_requested", { name }); return { http: 202, body: { ok: true, status: "pending" } }; }
    if (row.state === "pending") { this.db.prepare("UPDATE fleet_boxes SET reported_name=?, version=? WHERE id=?").run(name, version, row.id); return { http: 202, body: { ok: true, status: "pending" } }; }
    if (row.state === "rejected") throw Object.assign(bad(403, "this box was rejected"), { extra: { status: "rejected" } });
    if (row.state === "approved" && !row.key_hash) {           // approved by an Admin and the box is asking again: it now receives its key, once
      const key = randomBytes(32).toString("base64url");
      this.db.prepare("UPDATE fleet_boxes SET key_hash=?, key_issued_at=?, reported_name=?, version=? WHERE id=?").run(sha256(key), t, name, version, row.id);
      this.boxAudit(id, "fleet.enrol", { via: "approval" });
      return { http: 200, body: { ok: true, status: "approved", access_key: key, server_time: new Date(t).toISOString() } };
    }
    throw bad(409, row.state === "revoked" ? "access was revoked: ask an Admin for a new enrolment code" : "this box is already enrolled: ask an Admin for a new enrolment code");
  }

  // ---------- report intake (public route, key checked here) ----------
  report(ip: string, deviceId: string, bearer: string | null, body: any): { server_time: string; next_in_s: number } {
    const t = this.now();
    if (this.ipLimited(ip, t)) throw bad(429, "too many failed attempts");
    const row = this.box(deviceId), given = bearer ? sha256(bearer) : "";
    const okKey = !!row && row.state === "approved" && !!row.key_hash && !!given && given.length === row.key_hash.length && timingSafeEqual(Buffer.from(given), Buffer.from(row.key_hash));
    if (!okKey) {                                          // counted, never stored; the answer is the same for an unknown box, a revoked one and a wrong key
      this.noteIpFail(ip, t);
      if (row) this.db.prepare("UPDATE fleet_boxes SET auth_failures=auth_failures+1, last_auth_failure_at=? WHERE id=?").run(t, row.id); else { this.unknownFails.set(deviceId, (this.unknownFails.get(deviceId) ?? 0) + 1); if (this.unknownFails.size > 2000) this.unknownFails.clear(); }
      throw bad(401, "access key not accepted");
    }
    if (body && typeof body === "object" && typeof body.device_id === "string" && body.device_id.trim().toUpperCase() !== deviceId) throw bad(400, "Device ID header and body differ");
    const prev = this.lastAccepted.get(deviceId); if (prev !== undefined && t - prev < REPORT_GAP_MS) throw Object.assign(bad(429, "at most 1 report per 10 seconds"), { retryAfter: Math.ceil((REPORT_GAP_MS - (t - prev)) / 1000) });
    const r = parseReport(body); this.lastAccepted.set(deviceId, t); if (this.lastAccepted.size > 5000) for (const [k, v] of this.lastAccepted) if (t - v > 60_000) this.lastAccepted.delete(k);
    const wasStatus = boxStatus(row!.last_report_at, row!.interval_s, t);
    this.db.transaction(() => {
      this.db.prepare("UPDATE fleet_boxes SET last_report=?, last_report_at=?, first_report_at=COALESCE(first_report_at,?), interval_s=?, reported_name=?, version=?, report_count=report_count+1 WHERE id=?")
        .run(JSON.stringify(r), t, t, r.interval_s, r.box_name || row!.reported_name, r.version, row!.id);
      const cur = this.box(deviceId)!;
      if (cur.last_status !== "ONLINE") { if (row!.last_report_at === null) this.event(deviceId, t, "ONLINE", "first report"); else this.event(deviceId, t, "ONLINE", wasStatus === "ONLINE" ? "back online" : "back online after " + wasStatus.toLowerCase()); this.db.prepare("UPDATE fleet_boxes SET last_status='ONLINE' WHERE id=?").run(row!.id); }
      this.addExpected(deviceId, cur, t); this.db.prepare("INSERT INTO fleet_hours(device_id,hour_ts,expected,received) VALUES(?,?,0,1) ON CONFLICT(device_id,hour_ts) DO UPDATE SET received=received+1").run(deviceId, hourStart(t));
    })();
    return { server_time: new Date(t).toISOString(), next_in_s: r.interval_s };
  }

  // ---------- history ----------
  /** Reports expected in the hour of `t` (and the one before, so an hour that just ended is finished) = covered seconds / interval. */
  private addExpected(deviceId: string, box: BoxRow, t: number) {
    const from = box.first_report_at ?? t, iv = clampInterval(box.interval_s);
    for (const h of [hourStart(t) - HOUR, hourStart(t)]) {
      const cover = Math.min(t, h + HOUR) - Math.max(h, from); if (cover <= 0) continue;
      this.db.prepare("INSERT INTO fleet_hours(device_id,hour_ts,expected,received) VALUES(?,?,?,0) ON CONFLICT(device_id,hour_ts) DO UPDATE SET expected=MAX(expected, excluded.expected)").run(deviceId, h, Math.floor(cover / 1000 / iv));
    }
  }
  /** Once a minute (and in tests with a chosen time): status changes become events at their exact moment, and the expected count of the hour grows. Revoked and pending boxes are skipped; their history stays. */
  tick(t = this.now()) {
    for (const b of this.db.prepare("SELECT * FROM fleet_boxes WHERE state='approved' AND key_hash IS NOT NULL AND last_report_at IS NOT NULL").all() as BoxRow[]) {
      const s = boxStatus(b.last_report_at, b.interval_s, t);
      if (s !== "ONLINE" && b.last_status !== s) {
        this.db.transaction(() => {
          if (s === "OFFLINE" && b.last_status === "ONLINE") this.event(b.device_id, lateAt(b.last_report_at!, b.interval_s), "LATE", "no report for 3 intervals");
          this.event(b.device_id, s === "LATE" ? lateAt(b.last_report_at!, b.interval_s) : offlineAt(b.last_report_at!, b.interval_s), s, s === "LATE" ? "no report for 3 intervals" : "no report for 15 more minutes");
          this.db.prepare("UPDATE fleet_boxes SET last_status=? WHERE id=?").run(s, b.id);
        })();
      }
      this.addExpected(b.device_id, b, t);
    }
  }
  /** Nightly job: events and hourly records older than 30 days go; codes used or expired more than 30 days ago go. The latest report stays on the box row, history survives a revoke for its 30 days. */
  prune(t = this.now()): { events: number; hours: number; codes: number } {
    const cut = t - HISTORY_DAYS * DAY;
    const events = this.db.prepare("DELETE FROM fleet_events WHERE ts<?").run(cut).changes, hours = this.db.prepare("DELETE FROM fleet_hours WHERE hour_ts<?").run(hourStart(cut)).changes;
    const codes = this.db.prepare("DELETE FROM fleet_codes WHERE COALESCE(used_at, expires_at) < ?").run(cut).changes;
    return { events, hours, codes };
  }
  /** Runs the prune at most once per UTC day, from 03:00 on (box traffic is lowest). */
  maybePrune(t = this.now()) {
    const day = new Date(t).toISOString().slice(0, 10), last = (this.db.prepare("SELECT value v FROM settings WHERE key='fleet.pruned_on'").get() as { v: string } | undefined)?.v;
    if (new Date(t).getUTCHours() < 3 || last === day) return null;
    this.db.prepare("INSERT INTO settings(key,value) VALUES('fleet.pruned_on',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(day); return this.prune(t);
  }
  history(deviceId: string, t = this.now()) {
    const since = dayStart(t) - (HISTORY_DAYS - 1) * DAY;
    const rows = this.db.prepare("SELECT hour_ts,expected,received FROM fleet_hours WHERE device_id=? AND hour_ts>=?").all(deviceId, since) as { hour_ts: number; expected: number; received: number }[];
    const days = Array.from({ length: HISTORY_DAYS }, (_, i) => ({ day_ts: since + i * DAY, expected: 0, received: 0, pct: null as number | null }));
    for (const r of rows) { const d = days[Math.floor((r.hour_ts - since) / DAY)]; if (d) { d.expected += r.expected; d.received += Math.min(r.received, r.expected || r.received); } }
    let e = 0, g = 0; for (const d of days) { d.pct = d.expected > 0 ? Math.min(100, Math.round((d.received / d.expected) * 1000) / 10) : null; e += d.expected; g += d.received; }
    const events = this.db.prepare("SELECT ts,status,note FROM fleet_events WHERE device_id=? AND ts>=? ORDER BY ts DESC, id DESC LIMIT 200").all(deviceId, t - HISTORY_DAYS * DAY);
    const hours = this.db.prepare("SELECT hour_ts,expected,received FROM fleet_hours WHERE device_id=? AND hour_ts>=? ORDER BY hour_ts").all(deviceId, hourStart(t - (HISTORY_DAYS + 1) * DAY));      // 2026-11-19: raw UTC hour records, so the page can draw day cells in the Farm Profile time zone
    return { days, hours, percent_online_30d: e > 0 ? Math.min(100, Math.round((g / e) * 1000) / 10) : null, events, since };
  }
  percent30(): Map<string, number | null> {
    const cut = hourStart(this.now() - HISTORY_DAYS * DAY), m = new Map<string, number | null>();
    for (const r of this.db.prepare("SELECT device_id, SUM(expected) e, SUM(MIN(received, CASE WHEN expected>0 THEN expected ELSE received END)) g FROM fleet_hours WHERE hour_ts>=? GROUP BY device_id").all(cut) as { device_id: string; e: number; g: number }[]) m.set(r.device_id, r.e > 0 ? Math.min(100, Math.round((r.g / r.e) * 1000) / 10) : null);
    return m;
  }

  // ---------- admin actions ----------
  approve(by: string, id: unknown) { const b = this.boxById(id); if (!b) throw bad(404, "not found"); if (b.state !== "pending") throw bad(400, "only a box that is waiting can be approved");
    this.db.prepare("UPDATE fleet_boxes SET state='approved', first_enrolled_at=COALESCE(first_enrolled_at,?) WHERE id=?").run(this.now(), b.id); audit(this.db, by, "admin", "fleet.approve", { device_id: b.device_id }); }
  reject(by: string, id: unknown) { const b = this.boxById(id); if (!b) throw bad(404, "not found"); if (b.state !== "pending") throw bad(400, "only a box that is waiting can be rejected");
    this.db.prepare("UPDATE fleet_boxes SET state='rejected' WHERE id=?").run(b.id); audit(this.db, by, "admin", "fleet.reject", { device_id: b.device_id }); }
  revoke(by: string, id: unknown) { const b = this.boxById(id); if (!b) throw bad(404, "not found"); if (b.state !== "approved") throw bad(400, "only an enrolled box can be revoked");
    this.db.transaction(() => { this.db.prepare("UPDATE fleet_boxes SET state='revoked', key_hash=NULL, last_status='REVOKED' WHERE id=?").run(b.id); this.event(b.device_id, this.now(), "REVOKED", "access revoked by " + by); audit(this.db, by, "admin", "fleet.revoke", { device_id: b.device_id }); })(); }
  rename(by: string, id: unknown, name: unknown) { const b = this.boxById(id); if (!b) throw bad(404, "not found"); const n = clip(name, 64); if (!n) throw bad(400, "Name is required");
    this.db.prepare("UPDATE fleet_boxes SET display_name=? WHERE id=?").run(n, b.id); audit(this.db, by, "admin", "fleet.rename", { device_id: b.device_id, name: n }); }
}
export type { BoxStatus };
