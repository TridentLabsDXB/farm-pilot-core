// Licence service: installs, verifies and applies the licence. SAFETY FIRST: a licence problem can only ever stop ADDING sensors or gateways. It never touches polling, alarms or pump commands,
// because nothing outside the add paths calls into this file. Over a limit (older install, expired licence, downgrade) everything keeps running and ADD is refused.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { audit, getSetting, setSetting, type Db } from "../db.js";
import { HttpError, type Actor } from "../gateway/registry.js";
import { thisDeviceId } from "./device.js";
import { FREE_LICENCE, GRACE_DAYS } from "./free.js";
import { checkLicence, expiryMs, LicenceError, type KeyMap, type LicenceFile } from "./format.js";
import { LICENCE_PUBLIC_KEYS } from "./keys.js";
import { over, overLimit, type LicenceSummary } from "./summary.js";
import { usage } from "./usage.js";
import { reportsDaysFor, retentionDaysFor } from "./range.js";

export const SCHEMA_LICENCE = `CREATE TABLE IF NOT EXISTS licence (id INTEGER PRIMARY KEY, licence_id TEXT NOT NULL, type TEXT NOT NULL, licensed_to TEXT NOT NULL, limits_json TEXT NOT NULL, valid_until TEXT,
  installed_at INTEGER NOT NULL, installed_by TEXT NOT NULL, file_sha256 TEXT NOT NULL);`;
type Loaded = { kind: "none" } | { kind: "ok"; file: LicenceFile } | { kind: "invalid"; reason: string };
export interface LicenceOptions { dataDir?: string; keys?: KeyMap; deviceId?: () => string | null; now?: () => number; }

export class LicenceService {
  private loaded: Loaded = { kind: "none" }; private dir: string; private keys: KeyMap; private device: () => string | null; now: () => number;
  constructor(private db: Db, o: LicenceOptions = {}) {
    this.dir = join(o.dataDir ?? config.dataDir, "licence"); this.keys = o.keys ?? LICENCE_PUBLIC_KEYS; this.device = o.deviceId ?? (() => thisDeviceId()); this.now = o.now ?? Date.now;
    db.exec(SCHEMA_LICENCE); this.refresh();
  }
  // ---- Downgrade grace (2026-11-17) --------------------------------------------------------------------------------------------------------------------------------------
  // downgrade_at (settings key licence.downgrade_at, epoch ms, UTC) is recorded ONLY for a valid FREE state that follows a real licence: a clean expiry of a valid signed file, or a deliberate
  // REMOVE. For an expiry it is the moment this box first noticed it (not valid_until), so a box that was switched off for weeks still gets the full grace. An INVALID licence (unreadable,
  // missing file, bad signature, wrong box) never starts it and never prunes. Installing any valid licence clears it. Survives a restart (it lives in the database).
  private dgAt(): number | null { const v = getSetting(this.db, "licence.downgrade_at", ""), n = Number(v); return v !== "" && Number.isFinite(n) ? n : null; }
  private gracePruned() { return getSetting(this.db, "licence.grace_pruned_at", "") !== ""; }
  private graceInfo(at: number) { return { downgrade_at: new Date(at).toISOString(), delete_on: new Date(at + GRACE_DAYS * 86_400_000).toISOString(), grace_days: GRACE_DAYS }; }
  private startGrace(reason: "expired" | "removed", a: { username: string; role: string }, licenceId: string | null) {
    const at = this.now(); setSetting(this.db, "licence.downgrade_at", String(at)); setSetting(this.db, "licence.grace_pruned_at", "");
    audit(this.db, a.username, a.role, "licence.grace_started", { reason, licence_id: licenceId, ...this.graceInfo(at), retention_days_after: FREE_LICENCE.retentionDays });
  }
  /** Idempotent. Starts the grace when the loaded licence is a valid file that has now expired and no grace exists yet. Called from refresh(), summary() and retentionDays(), so a licence that
   *  runs out between two daily checks can never let a retention run prune before the clock is recorded. Does not call summary(). */
  private syncGrace() {
    const L = this.loaded; if (L.kind !== "ok" || this.now() < expiryMs(L.file) || this.dgAt() !== null) return;
    this.startGrace("expired", { username: "system", role: "system" }, L.file.licence_id);
  }
  /** True when the grace is over and its prune has not run yet (the retention job then prunes to the FREE limit once and calls markGracePruned). */
  graceEnded() { const d = this.dgAt(), st = this.loaded.kind === "invalid" ? "INVALID" : this.loaded.kind === "ok" && this.now() < expiryMs(this.loaded.file) ? "LICENSED" : "FREE"; return st === "FREE" && d !== null && !this.gracePruned() && this.now() >= d + GRACE_DAYS * 86_400_000; }
  markGracePruned(detail: { cutoff: string; days: number | null; history_raw: number; rollup_hourly: number }) {
    const d = this.dgAt(); setSetting(this.db, "licence.grace_pruned_at", String(this.now()));
    audit(this.db, "system", "system", "licence.grace_prune", { downgrade_at: d === null ? null : new Date(d).toISOString(), ...detail });
  }
  private get file() { return join(this.dir, "current.fplic"); }
  private row() { return this.db.prepare("SELECT * FROM licence ORDER BY id DESC LIMIT 1").get() as { id: number; licence_id: string; type: string; file_sha256: string } | undefined; }

  /** Re-reads and re-verifies the stored file (at start, every day, after install and remove). Audits a change to EXPIRED or INVALID once. Never throws. */
  refresh() {
    try {
      const row = this.row(), has = existsSync(this.file);
      if (!row && !has) this.loaded = { kind: "none" };
      else if (row && !has) this.loaded = { kind: "invalid", reason: "The licence file is missing from this box. Upload the licence again." };
      else {
        const buf = readFileSync(this.file);
        try {
          const f = checkLicence(buf, this.keys, this.device());
          this.loaded = row && row.file_sha256 === createHash("sha256").update(buf).digest("hex") ? { kind: "ok", file: f } : { kind: "invalid", reason: "The licence file does not match what was installed. Upload the licence again." };
        } catch (e) { this.loaded = { kind: "invalid", reason: e instanceof LicenceError ? e.message : "The licence file could not be checked." }; }
      }
    } catch { this.loaded = { kind: "invalid", reason: "The licence could not be read." }; }
    this.syncGrace(); this.noteState();
  }
  private noteState() {
    const s = this.summary(), tag = s.state === "EXPIRED" || s.state === "INVALID" ? `${s.state}:${this.loaded.kind === "ok" ? this.loaded.file.licence_id : s.reason}` : "";
    if ((getSetting(this.db, "licence.noted", "")) === tag) return; setSetting(this.db, "licence.noted", tag);
    if (tag) audit(this.db, "system", "system", s.state === "EXPIRED" ? "licence.expired" : "licence.invalid", { state: s.state, reason: s.reason ?? null, falls_back_to: "FREE" });
  }
  /** How many days back charts, CSV export and Reports may reach: 7 on FREE (also EXPIRED and INVALID), null on a valid licence. Read live, so a licence change applies without a restart. */
  reportsDays() { return reportsDaysFor(this.summary()); }
  /** Days of history to keep (raw and hourly rows); null = never prune. Read at every retention run, so a licence change applies without a restart. */
  // 2026-11-17 -- grace-aware: INVALID never prunes (null); a FREE / EXPIRED box inside its 30-day grace prunes nothing (null); otherwise the licence's own number (FREE 90 after the grace).
  retentionDays() {
    this.syncGrace(); const s = this.summary(); if (s.state === "INVALID") return null; if (s.state === "LICENSED") return retentionDaysFor(s);
    const d = this.dgAt(); if (d !== null && !this.gracePruned() && this.now() < d + GRACE_DAYS * 86_400_000) return null;
    return retentionDaysFor(s);
  }
  /** Effective limits: the licence's own while it is LICENSED, FREE otherwise (expired, invalid, none). */
  limits() { return this.summary().limits; }
  summary(): LicenceSummary {
    this.syncGrace(); const dg = this.dgAt(), grace = dg !== null && !this.gracePruned() && !(this.loaded.kind === "ok" && this.now() < expiryMs(this.loaded.file)) && this.loaded.kind !== "invalid" ? this.graceInfo(dg) : null;
    return { ...this.baseSummary(), grace };
  }
  private baseSummary(): LicenceSummary {
    const free: { gateways: number | null; sensors: number | null } = { gateways: FREE_LICENCE.gateways, sensors: FREE_LICENCE.sensors }, u = usage(this.db), L = this.loaded;
    const freeNums = { reports_days: FREE_LICENCE.reportsDays as number | null, retention_days: FREE_LICENCE.retentionDays as number | null };
    if (L.kind === "ok") {
      const f = L.file, expired = this.now() >= expiryMs(f), limits = expired ? free : { gateways: f.limits.gateways, sensors: f.limits.sensors };
      // v1 file: no reports_days / retention_days -> reports unlimited inside retention, retention 365 days. v2: as signed (null = unlimited / never prune).
      const nums = expired ? freeNums : { reports_days: f.limits.reports_days === undefined ? null : f.limits.reports_days, retention_days: f.limits.retention_days === undefined ? 365 : f.limits.retention_days };
      return { type: f.type, licensed_to: f.licensed_to, valid_until: f.valid_until, state: expired ? "EXPIRED" : "LICENSED", limits, usage: u, over_limit: overLimit(u, limits), ...nums, ...(expired ? { reason: "The licence has expired. Free limits apply until a new licence is installed." } : {}) };
    }
    return { type: FREE_LICENCE.type, licensed_to: null, valid_until: null, state: L.kind === "invalid" ? "INVALID" : "FREE", limits: free, usage: u, over_limit: overLimit(u, free), ...freeNums, ...(L.kind === "invalid" ? { reason: L.reason } : {}) };
  }
  private limitText(what: string) {
    const s = this.summary(), name = s.state === "LICENSED" ? `Licence ${s.type}` : "Free licence"; return `${name} allows ${s.limits[what === "sensor" ? "sensors" : "gateways"]} ${what}${(what === "sensor" ? s.limits.sensors : s.limits.gateways) === 1 ? "" : "s"} in total. Upload a licence on the About page.`;
  }
  private refuse(what: "sensor" | "gateway"): never { throw new HttpError(409, this.limitText(what), { code: "LICENCE_LIMIT", limit: what }); }
  /** ADD paths only. Refuses when `n` more would pass the limit, and always when the box is already over it. */
  checkSensorsAdd(n: number) { const s = this.summary(); if (over(s.usage.sensors + n, s.limits.sensors)) this.refuse("sensor"); }
  /** A restore replaces all sensors: refuse a backup that would end above the limit AND hold more than the box has now (a smaller or equal set adds nothing). */
  checkSensorsTotal(total: number) { const s = this.summary(); if (over(total, s.limits.sensors) && total > s.usage.sensors) this.refuse("sensor"); }
  /** SEND TO GATEWAY: refused when sensors that are not in the gateway yet would be pushed while the registry is above the limit. Interval changes and removals always go through. */
  checkSend(total: number, unsent: number) { const s = this.summary(); if (unsent > 0 && over(total, s.limits.sensors)) this.refuse("sensor"); }
  checkGatewayAdd(n = 1) { const s = this.summary(); if (over(s.usage.gateways + n, s.limits.gateways)) this.refuse("gateway"); }

  install(a: Actor, buf: Buffer): LicenceSummary {
    const sha = createHash("sha256").update(buf).digest("hex"), prev = this.row();
    const refuse = (e: LicenceError): never => { audit(this.db, a.username, a.role, "licence.refused", { code: e.code, reason: e.message, file_sha256: sha, bytes: buf.length }); throw new HttpError(400, e.message, { code: e.code }); };
    let f: LicenceFile; try { f = checkLicence(buf, this.keys, this.device()); if (this.now() >= expiryMs(f)) throw new LicenceError("EXPIRED", `This licence expired on ${f.valid_until!.slice(0, 10)}. Ask Trident Labs for a new one.`);
      if (prev && f.licence_id < prev.licence_id) throw new LicenceError("OLDER_LICENCE", `This licence (${f.licence_id}) is older than the one installed (${prev.licence_id}). Use the newest file you were sent.`); }
    catch (e) { if (e instanceof LicenceError) return refuse(e); throw e; }
    mkdirSync(this.dir, { recursive: true }); const tmp = this.file + ".new"; writeFileSync(tmp, buf, { mode: 0o600 }); renameSync(tmp, this.file);
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM licence").run();
      this.db.prepare("INSERT INTO licence(licence_id,type,licensed_to,limits_json,valid_until,installed_at,installed_by,file_sha256) VALUES(?,?,?,?,?,?,?,?)").run(f.licence_id, f.type, f.licensed_to, JSON.stringify(f.limits), f.valid_until, this.now(), a.username, sha);
      audit(this.db, a.username, a.role, "licence.install", { licence_id: f.licence_id, type: f.type, licensed_to: f.licensed_to, device_id: f.device_id, limits: f.limits, valid_until: f.valid_until, replaced: prev?.licence_id ?? null, file_sha256: sha });
      const was = this.dgAt();      // a valid licence ends any grace: nothing is deleted, the notice goes away. Replacing one valid licence with another never starts a clock.
      if (was !== null || this.gracePruned()) { setSetting(this.db, "licence.downgrade_at", ""); setSetting(this.db, "licence.grace_pruned_at", ""); if (was !== null) audit(this.db, a.username, a.role, "licence.grace_cancelled", { licence_id: f.licence_id, type: f.type, was_downgrade_at: new Date(was).toISOString() }); }
    })();
    this.refresh(); return this.summary();
  }
  /** Back to FREE. The audit log keeps the history (licence.install rows). History older than the FREE limit stays for GRACE_DAYS (see startGrace). */
  remove(a: Actor): LicenceSummary {
    const row = this.row(); if (!row && !existsSync(this.file)) throw new HttpError(404, "There is no licence to remove.");
    rmSync(this.file, { force: true }); this.db.prepare("DELETE FROM licence").run(); audit(this.db, a.username, a.role, "licence.remove", { licence_id: row?.licence_id ?? null, type: row?.type ?? null });
    if (this.dgAt() === null) this.startGrace("removed", a, row?.licence_id ?? null);      // deliberate removal = valid FREE state: the 30-day clock starts now (an already running grace keeps its start)
    this.refresh(); return this.summary();
  }
}
