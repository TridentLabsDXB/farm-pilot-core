// 2026-11-19 -- Server Connection settings and contact log, in the box's own SQLite database.
// Keys live in `settings` under the prefix sl. (backup and diagnostics use allow-lists that do not contain it, so none of it leaves the box; the key is also encrypted: mqtt/secret.ts, AES-256-GCM).
import type { Db } from "../db.js";
import { getSetting, setSetting } from "../db.js";
import { decryptSecret, encryptSecret } from "../mqtt/secret.js";

export const INTERVALS = [60, 300, 900] as const;
export const DEFAULT_ADDRESS = "https://core.farm-pilot.com";
export type EnrolState = "none" | "pending" | "approved" | "rejected";
export interface LinkSettings { enabled: boolean; address: string; box_name: string; interval_s: number; enrol_state: EnrolState; enrolled_at: number | null; report_no: number; }
export interface Contact { id: number; ts: number; ok: boolean; code: number | null; error: string | null; rtt_ms: number | null; report_no: number | null; kind: "report" | "enrol"; }

export const SCHEMA_LINK = `CREATE TABLE IF NOT EXISTS server_contacts (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, ok INTEGER NOT NULL, code INTEGER, error TEXT, rtt_ms INTEGER, report_no INTEGER, kind TEXT NOT NULL DEFAULT 'report');
CREATE INDEX IF NOT EXISTS idx_server_contacts_ts ON server_contacts(ts);`;

export class LinkStore {
  constructor(private db: Db) { db.exec(SCHEMA_LINK); }
  settings(defaultName: string): LinkSettings {
    const g = (k: string, d: string) => getSetting(this.db, "sl." + k, d), st = g("enrol_state", "none");
    const iv = Number(g("interval_s", "60"));
    return { enabled: g("enabled", "0") === "1", address: g("address", DEFAULT_ADDRESS), box_name: g("box_name", defaultName), interval_s: (INTERVALS as readonly number[]).includes(iv) ? iv : 60,
      enrol_state: st === "pending" || st === "approved" || st === "rejected" ? st : "none", enrolled_at: g("enrolled_at", "") ? Number(g("enrolled_at", "")) : null, report_no: Number(g("report_no", "0")) || 0 };
  }
  put(k: string, v: string) { setSetting(this.db, "sl." + k, v); }
  save(p: Partial<{ enabled: boolean; address: string; box_name: string; interval_s: number }>) { for (const [k, v] of Object.entries(p)) this.put(k, typeof v === "boolean" ? (v ? "1" : "0") : String(v)); }
  hasKey(): boolean { return !!this.db.prepare("SELECT 1 FROM settings WHERE key='sl.key_enc'").get(); }
  /** The plain access key, for the one place that sends it. Never returned by any route. null = none stored or unreadable (wrong secret key file). */
  key(): string | null { const r = getSetting(this.db, "sl.key_enc", ""); return r ? decryptSecret(r) : null; }
  setKey(plain: string) { this.put("key_enc", encryptSecret(plain)); }
  clearKey() { this.db.prepare("DELETE FROM settings WHERE key='sl.key_enc'").run(); }
  nextReportNo(): number { const n = (Number(getSetting(this.db, "sl.report_no", "0")) || 0) + 1; this.put("report_no", String(n)); return n; }

  addContact(c: Omit<Contact, "id">) {
    this.db.prepare("INSERT INTO server_contacts(ts,ok,code,error,rtt_ms,report_no,kind) VALUES(?,?,?,?,?,?,?)").run(c.ts, c.ok ? 1 : 0, c.code, c.error, c.rtt_ms, c.report_no, c.kind);
    this.db.prepare("DELETE FROM server_contacts WHERE ts < ? OR id NOT IN (SELECT id FROM server_contacts ORDER BY id DESC LIMIT 3000)").run(c.ts - 2 * 86400_000);      // today's counters need today only; the page shows 20
  }
  recent(n = 20): Contact[] { return (this.db.prepare("SELECT id,ts,ok,code,error,rtt_ms,report_no,kind FROM server_contacts ORDER BY id DESC LIMIT ?").all(n) as any[]).map((r) => ({ ...r, ok: !!r.ok })); }
  /** The newest contact, except that a successful enrolment is not a report: right after it there is no attempt yet (null), so the lamp stays CONNECTING until the first report goes through. */
  lastAttempt(): Contact | null { const r = this.recent(1)[0] ?? null; return r && r.kind === "enrol" && r.ok ? null : r; }
  lastOk(): Contact | null { const r = this.db.prepare("SELECT id,ts,ok,code,error,rtt_ms,report_no,kind FROM server_contacts WHERE ok=1 AND kind='report' ORDER BY id DESC LIMIT 1").get() as any; return r ? { ...r, ok: true } : null; }
  /** Failures in a row, newest first, since the last success. */
  failStreak(): number { const r = this.db.prepare("SELECT COUNT(*) c FROM server_contacts WHERE id > COALESCE((SELECT MAX(id) FROM server_contacts WHERE ok=1),0)").get() as { c: number }; return r.c; }
  today(startOfDay: number): { ok: number; failed: number } { const r = this.db.prepare("SELECT COALESCE(SUM(ok),0) ok, COALESCE(SUM(1-ok),0) failed FROM server_contacts WHERE ts>=? AND kind='report'").get(startOfDay) as { ok: number; failed: number }; return r; }
}
