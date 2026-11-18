// 2026-11-19 -- Server Connection client (box side). HTTPS only, outbound only: this file never opens a listening port and nothing the server answers can make the box DO anything
// except store the access key it just asked for and show a clock warning. There is no command, no configuration push, no remote access.
//
// ISOLATION (owner rule: a server problem must never block or slow monitoring, alarms, control or the UI):
//  - every network call is async with its own hard timeout (10 s); nothing in the poll loop, the alarm tracker or a route ever awaits this class;
//  - everything the client does runs inside try/catch: a throwing fetch, a bad answer or a full disk is a FAILED contact, never an exception that escapes;
//  - the schedule is ONE timer chain, so a slow server can never pile up requests; only the latest state is sent, nothing is queued (a failed report is simply not sent again, the next one carries the newer state);
//  - the only shared resource is SQLite, in tiny synchronous writes of the same kind the rest of CORE does all day.
//  test/server-link.test.ts runs a stand-in poll loop next to a server that never answers and measures that the loop keeps its rhythm.
import type { Db } from "../db.js";
import { audit } from "../db.js";
import type { LicenceSummary } from "../licence/summary.js";
import { buildReport, dbFacts, runsAs as detectRunsAs, type Report, type RunsAs } from "./report.js";
import { DEFAULT_ADDRESS, INTERVALS, LinkStore, type Contact, type LinkSettings } from "./store.js";

export type LinkState = "CONNECTED" | "CONNECTING" | "NOT_REACHABLE" | "NOT_ENROLLED" | "DISABLED";
export const BACKOFF_S = [60, 120, 300, 900];                               // after the 1st, 2nd, 3rd failure, then every 15 minutes
export const backoffS = (failures: number) => BACKOFF_S[Math.min(Math.max(failures, 1), BACKOFF_S.length) - 1];
export const FAILS_BEFORE_NOT_REACHABLE = 3;
export const CLOCK_WARN_S = 120;
const TIMEOUT_MS = 10_000;

export interface LinkDeps {
  db: Db; licence: () => LicenceSummary; deviceId: () => string | null; version: () => { version: string; build: string }; os: () => string;
  fetchFn?: typeof fetch; now?: () => number; runsAs?: () => RunsAs; timeoutMs?: number; defaultName?: () => string;
  /** Tests only: lets an http://127.0.0.1 server stand in for the real one. Production code never sets it, so plain HTTP is refused. */
  allowInsecure?: boolean; firstDelayMs?: number;
}
export interface LinkStatus {
  state: LinkState; reason: string | null; host: string | null; enrolment: "NOT ENROLLED" | "WAITING FOR APPROVAL" | "APPROVED" | "REJECTED";
  last_contact_at: number | null; last_contact_ok: boolean | null; round_trip_ms: number | null; next_report_in_s: number | null; reports_today: { ok: number; failed: number };
  clock_diff_s: number | null; clock_warning: boolean; busy: boolean; device_id: string | null;
}
export interface ActionResult { ok: boolean; message: string; http?: number | null; round_trip_ms?: number | null; }

/** Plain-words reason for a failed fetch. Never includes a URL, a header or the key. */
export function describeError(e: any): string {
  const code = String(e?.cause?.code ?? e?.code ?? ""), name = String(e?.name ?? "");
  if (name === "TimeoutError" || name === "AbortError" || /TIMEOUT/.test(code)) return "no answer in time";
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS|DEPTH_ZERO|HOSTNAME_MISMATCH/.test(code)) return "certificate not accepted";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "server name not found";
  if (code === "ECONNREFUSED") return "connection refused";
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") return "no route to host";
  if (code === "ECONNRESET" || code === "UND_ERR_SOCKET") return "connection closed";
  return code ? code.toLowerCase().replace(/_/g, " ") : "request failed";
}
const httpReason = (c: number) => c === 401 ? "access revoked or key not accepted" : c === 403 ? "server refused this box" : c === 429 ? "server is limiting this box" : c === 413 ? "report too large" : c >= 500 ? "server error" : `HTTP ${c}`;

/** Address check shared by the settings route and the client. Returns the clean origin (no path), or throws a plain sentence. */
export function cleanAddress(raw: unknown, allowInsecure = false): string {
  const s = typeof raw === "string" ? raw.trim() : ""; if (!s || s.length > 200) throw new Error("Enter the server address, like https://core.farm-pilot.com");
  let u: URL; try { u = new URL(s); } catch { throw new Error("The server address is not a valid web address"); }
  if (u.protocol !== "https:" && !(allowInsecure && u.protocol === "http:")) throw new Error("The server address must start with https:// (plain HTTP is not allowed)");
  if (u.username || u.password) throw new Error("The server address must not contain a user name or password");
  if ((u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) throw new Error("Enter only the server name, without a path");
  return u.origin;
}

export class ServerLink {
  readonly store: LinkStore; private timer: NodeJS.Timeout | null = null; private inflight: Promise<ActionResult> | null = null; private stopped = true; private nextAt: number | null = null; private clockDiffS: number | null = null;
  private fetchFn: typeof fetch; private now: () => number;
  constructor(private d: LinkDeps) { this.store = new LinkStore(d.db); this.fetchFn = d.fetchFn ?? fetch; this.now = d.now ?? Date.now; }
  private name() { return this.d.defaultName?.() ?? "FARM-PILOT CORE"; }
  settings(): LinkSettings { return this.store.settings(this.name()); }
  private timeout() { return this.d.timeoutMs ?? TIMEOUT_MS; }

  // ---------- state ----------
  status(): LinkStatus {
    const s = this.settings(), last = this.store.lastAttempt(), ok = this.store.lastOk(), fails = this.store.failStreak(), keyed = this.store.hasKey();
    const enrolment = keyed ? "APPROVED" : s.enrol_state === "pending" ? "WAITING FOR APPROVAL" : s.enrol_state === "rejected" ? "REJECTED" : "NOT ENROLLED";
    let state: LinkState, reason: string | null = null;
    if (!s.enabled) state = "DISABLED";
    else if (!keyed) { state = "NOT_ENROLLED"; reason = enrolment === "WAITING FOR APPROVAL" ? "waiting for an Admin on the server to approve this box" : enrolment === "REJECTED" ? "the server rejected this box" : null; }
    else if (!last) state = "CONNECTING";
    else if (last.ok) state = "CONNECTED";
    else { const revoked = last.code === 401 || last.code === 403; state = revoked || fails >= FAILS_BEFORE_NOT_REACHABLE ? "NOT_REACHABLE" : "CONNECTING"; reason = last.error; }
    const t = this.now(), day = new Date(t); day.setHours(0, 0, 0, 0);
    return { state, reason, host: hostOf(s.address), enrolment, last_contact_at: ok?.ts ?? null, last_contact_ok: last ? last.ok : null, round_trip_ms: ok?.rtt_ms ?? null,
      next_report_in_s: this.nextAt && s.enabled && keyed ? Math.max(0, Math.round((this.nextAt - t) / 1000)) : null, reports_today: this.store.today(day.getTime()),
      clock_diff_s: this.clockDiffS, clock_warning: this.clockDiffS !== null && Math.abs(this.clockDiffS) > CLOCK_WARN_S, busy: !!this.inflight, device_id: this.d.deviceId() };
  }
  view() { return { settings: this.settings(), status: this.status(), contacts: this.store.recent(20) }; }                // no key, not even its length

  // ---------- settings ----------
  save(who: { username: string; role: string }, b: any): LinkSettings {
    const cur = this.settings(), patch: Partial<{ enabled: boolean; address: string; box_name: string; interval_s: number }> = {};
    if (b.enabled !== undefined) { if (typeof b.enabled !== "boolean") throw new Error("enabled must be true or false"); patch.enabled = b.enabled; }
    if (b.address !== undefined) patch.address = cleanAddress(b.address, this.d.allowInsecure);
    if (b.box_name !== undefined) { const n = String(b.box_name).replace(/[\u0000-\u001f\u007f]/g, " ").trim(); if (!n || n.length > 64) throw new Error("Box name: 1 to 64 characters"); patch.box_name = n; }
    if (b.interval_s !== undefined) { const n = Number(b.interval_s); if (!(INTERVALS as readonly number[]).includes(n)) throw new Error("Report every 1, 5 or 15 minutes"); patch.interval_s = n; }
    const keyDropped = patch.address !== undefined && patch.address !== cur.address && (this.store.hasKey() || cur.enrol_state !== "none");
    this.store.save(patch);
    if (keyDropped) { this.store.clearKey(); this.store.put("enrol_state", "none"); }       // a key belongs to ONE server: a new address means enrol again
    audit(this.d.db, who.username, who.role, "server_link.settings", { ...patch, ...(keyDropped ? { enrolment_cleared: true } : {}) });
    this.reschedule(); return this.settings();
  }

  // ---------- network ----------
  private async post(path: string, body: unknown, headers: Record<string, string>, address = this.settings().address): Promise<{ http: number; json: any; rtt: number }> {
    const base = cleanAddress(address, this.d.allowInsecure), t0 = this.now();
    const r = await this.fetchFn(base + path, { method: "POST", redirect: "error", headers: { "content-type": "application/json", "user-agent": "farmpilot-core", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeout()) });
    const text = await r.text().then((x) => x.slice(0, 8192)).catch(() => ""); let json: any = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { http: r.status, json, rtt: Math.max(0, this.now() - t0) };
  }
  private noteClock(json: any) { const t = Date.parse(json?.server_time); if (Number.isFinite(t)) this.clockDiffS = Math.round((t - this.now()) / 1000); }

  /** One report. Never throws. */
  private async sendReport(): Promise<ActionResult> {
    const s = this.settings(), t = this.now(); let reportNo: number | null = null;
    try {
      const id = this.d.deviceId(); if (!id) return this.fail(t, null, "this computer has no Device ID", null, null);
      const key = this.store.key(); if (!key) return this.fail(t, null, "no readable access key (enrol again)", null, null);
      reportNo = this.store.nextReportNo(); const v = this.d.version(), f = dbFacts(this.d.db);
      const report: Report = buildReport({ deviceId: id, boxName: s.box_name, reportNo, now: t, intervalS: s.interval_s, version: v.version, build: v.build, os: this.d.os(), runsAs: (this.d.runsAs ?? (() => detectRunsAs()))(), uptimeS: process.uptime(), licence: this.d.licence(), lastDataAt: f.lastDataAt, activeAlarms: f.activeAlarms });
      const r = await this.post("/api/fleet/report", report, { "x-device-id": id, authorization: `Bearer ${key}` });
      if (r.http >= 200 && r.http < 300 && r.json?.ok === true) { this.noteClock(r.json); return this.good(t, r.http, r.rtt, reportNo, "report"); }
      return this.fail(t, r.http, httpReason(r.http), r.rtt, reportNo);
    } catch (e) { return this.fail(t, null, describeError(e), null, reportNo); }
  }
  private good(ts: number, http: number, rtt: number, reportNo: number | null, kind: Contact["kind"]): ActionResult { try { this.store.addContact({ ts, ok: true, code: http, error: null, rtt_ms: rtt, report_no: reportNo, kind }); } catch { /* the log is a convenience */ } return { ok: true, message: "OK", http, round_trip_ms: rtt }; }
  private fail(ts: number, http: number | null, error: string, rtt: number | null, reportNo: number | null, kind: Contact["kind"] = "report"): ActionResult { try { this.store.addContact({ ts, ok: false, code: http, error, rtt_ms: rtt, report_no: reportNo, kind }); } catch { /* ditto */ } return { ok: false, message: error, http, round_trip_ms: rtt }; }

  /** Send the report now (SEND NOW). Does not change settings. Joins a send that is already running. */
  sendNow(who?: { username: string; role: string }): Promise<ActionResult> {
    if (who) audit(this.d.db, who.username, who.role, "server_link.send_now", {});
    const s = this.settings(); if (!s.enabled) return Promise.resolve({ ok: false, message: "Reporting is switched off" }); if (!this.store.hasKey()) return Promise.resolve({ ok: false, message: "This box is not enrolled yet" });
    return this.run();
  }
  private run(): Promise<ActionResult> {
    if (this.inflight) return this.inflight;
    const p = (async () => { try { return await this.sendReport(); } finally { this.inflight = null; this.reschedule(); } })();
    this.inflight = p; return p;
  }

  /** TEST CONNECTION: can this box reach the server over verified TLS? Uses the public health address, sends no report, stores nothing, changes nothing. */
  async test(address?: unknown): Promise<ActionResult> {
    try {
      const base = cleanAddress(address ?? this.settings().address, this.d.allowInsecure), t0 = this.now();
      const r = await this.fetchFn(base + "/api/health", { redirect: "error", headers: { "user-agent": "farmpilot-core" }, signal: AbortSignal.timeout(this.timeout()) }), rtt = Math.max(0, this.now() - t0);
      const text = await r.text().then((x) => x.slice(0, 4096)).catch(() => ""); let j: any = null; try { j = JSON.parse(text); } catch { /* html */ }
      if (j?.server_time) this.noteClock(j);
      return r.ok ? { ok: true, message: "Server reached over a verified secure connection", http: r.status, round_trip_ms: rtt } : { ok: false, message: httpReason(r.status), http: r.status, round_trip_ms: rtt };
    } catch (e: any) { return { ok: false, message: e instanceof Error && /^(Enter|The server|Enter only)/.test(e.message) ? e.message : describeError(e) }; }
  }

  /** Enrolment. With a code the server approves at once; without one it queues the box for an Admin (WAITING FOR APPROVAL) and the box asks again on its schedule. */
  async enrol(who: { username: string; role: string }, code?: string): Promise<ActionResult & { state: string }> {
    const t = this.now();
    try {
      const id = this.d.deviceId(); if (!id) return { ok: false, message: "This computer has no Device ID", state: this.status().enrolment };
      const s = this.settings(), c = (code ?? "").trim().toUpperCase(); if (c && !/^[A-Z0-9-]{4,24}$/.test(c)) return { ok: false, message: "The enrolment code looks wrong", state: this.status().enrolment };
      const v = this.d.version(), r = await this.post("/api/fleet/enrol", { v: 1, device_id: id, name: s.box_name, version: v.version, ...(c ? { code: c } : {}) }, { "x-device-id": id });
      const key = r.json?.access_key;
      if (r.http === 200 && typeof key === "string" && /^[A-Za-z0-9_-]{32,128}$/.test(key)) {
        this.store.setKey(key); this.store.put("enrol_state", "approved"); this.store.put("enrolled_at", String(t)); this.noteClock(r.json);
        this.store.addContact({ ts: t, ok: true, code: 200, error: null, rtt_ms: r.rtt, report_no: null, kind: "enrol" });
        audit(this.d.db, who.username, who.role, "server_link.enrol", { host: hostOf(s.address), with_code: !!c }); this.reschedule(); return { ok: true, message: "Enrolled", state: "APPROVED", http: 200, round_trip_ms: r.rtt };
      }
      if (r.http === 202) { this.store.clearKey(); this.store.put("enrol_state", "pending"); audit(this.d.db, who.username, who.role, "server_link.enrol_requested", { host: hostOf(s.address) }); this.reschedule(); return { ok: true, message: "Waiting for an Admin on the server to approve this box", state: "WAITING FOR APPROVAL", http: 202, round_trip_ms: r.rtt }; }
      if (r.http === 403 && r.json?.status === "rejected") { this.store.put("enrol_state", "rejected"); return { ok: false, message: "The server rejected this box", state: "REJECTED", http: 403 }; }
      const why = typeof r.json?.error === "string" ? r.json.error.replace(/[\u0000-\u001f]/g, " ").slice(0, 160) : httpReason(r.http);
      this.store.addContact({ ts: t, ok: false, code: r.http, error: why, rtt_ms: r.rtt, report_no: null, kind: "enrol" }); return { ok: false, message: why, state: this.status().enrolment, http: r.http };
    } catch (e: any) { const m = /^(Enter|The server)/.test(String(e?.message)) ? e.message : describeError(e); try { this.store.addContact({ ts: t, ok: false, code: null, error: m, rtt_ms: null, report_no: null, kind: "enrol" }); } catch { /* ignore */ } return { ok: false, message: m, state: this.status().enrolment }; }
  }

  // ---------- schedule ----------
  start() { this.stopped = false; this.reschedule(this.d.firstDelayMs ?? 5000); }
  stop() { this.stopped = true; if (this.timer) clearTimeout(this.timer); this.timer = null; this.nextAt = null; }
  /** Delay to the next attempt: the interval after a success, the backoff after failures (the NEXT report always carries the newest state, so a missed one is never repeated). */
  nextDelayMs(): number { const s = this.settings(), f = this.store.failStreak(); return (f > 0 ? backoffS(f) : s.interval_s) * 1000; }
  private reschedule(first?: number) {
    if (this.timer) clearTimeout(this.timer); this.timer = null; this.nextAt = null; if (this.stopped) return;
    const s = this.settings(); if (!s.enabled || (!this.store.hasKey() && s.enrol_state !== "pending")) return;
    const ms = first ?? this.nextDelayMs(); this.nextAt = this.now() + ms;
    this.timer = setTimeout(() => { void this.tick(); }, ms); this.timer.unref?.();
  }
  private async tick() {
    this.timer = null;
    try {
      const s = this.settings();
      if (s.enabled && !this.store.hasKey() && s.enrol_state === "pending") await this.enrol({ username: "system", role: "system" });        // asks again whether an Admin approved this box
      else if (s.enabled && this.store.hasKey()) await this.run();
    } catch { /* never escapes */ }
    finally { this.reschedule(); }
  }
}
export const hostOf = (address: string) => { try { return new URL(address).host; } catch { return null; } };
export { DEFAULT_ADDRESS };
