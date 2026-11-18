// 2026-11-19 -- Server Connection, version 1 report (docs: core-server-connection-spec.md, "Report format (version 1)").
// METADATA ONLY. The report is assembled from this explicit list of fields; nothing is copied from a table by pattern, so a new column can never leak into it.
// NEVER SENT: farm readings, sensor values, users, passwords, contacts, farm logo, notes, serial numbers, the access key. test/server-link.test.ts scans a real report for all of them.
import type { Db } from "../db.js";
import type { LicenceSummary } from "../licence/summary.js";

export const REPORT_MAX_BYTES = 4096;
export type RunsAs = "service" | "console" | "systemd";
export interface Report {
  v: 1; device_id: string; box_name: string; report_no: number; sent_at: string; interval_s: number;
  version: string; build: string; os: string; runs_as: RunsAs; uptime_s: number;
  licence: { type: string; valid_until: string | null; state: string };
  usage: { data_sources: { n: number; max: number | null }; sensors: { n: number; max: number | null } };
  last_data_at: string | null; active_alarms: number;
}
export interface ReportInput { deviceId: string; boxName: string; reportNo: number; now: number; intervalS: number; version: string; build: string; os: string; runsAs: RunsAs; uptimeS: number; licence: LicenceSummary; lastDataAt: number | null; activeAlarms: number; }

const clip = (s: string, n: number) => s.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, n);
const iso = (ms: number | null) => (ms === null || !Number.isFinite(ms) ? null : new Date(ms).toISOString());

export function buildReport(i: ReportInput): Report {
  const r: Report = {
    v: 1, device_id: i.deviceId, box_name: clip(i.boxName, 64), report_no: i.reportNo, sent_at: new Date(i.now).toISOString(), interval_s: i.intervalS,
    version: clip(i.version, 32), build: clip(i.build, 40), os: clip(i.os, 120), runs_as: i.runsAs, uptime_s: Math.max(0, Math.round(i.uptimeS)),
    licence: { type: clip(i.licence.type, 24), valid_until: i.licence.valid_until, state: i.licence.state },
    usage: { data_sources: { n: i.licence.usage.gateways, max: i.licence.limits.gateways }, sensors: { n: i.licence.usage.sensors, max: i.licence.limits.sensors } },    // `max` null = unlimited
    last_data_at: iso(i.lastDataAt), active_alarms: i.activeAlarms,
  };
  if (Buffer.byteLength(JSON.stringify(r)) > REPORT_MAX_BYTES) throw new Error("report larger than 4 KB");
  return r;
}

/** The two facts that come from the database: a TIMESTAMP of the newest sensor reading (never the value) and a COUNT of open alarms. Tables that do not exist yet count as nothing. */
export function dbFacts(db: Db): { lastDataAt: number | null; activeAlarms: number } {
  const one = (sql: string) => { try { return (db.prepare(sql).get() as { c: number | null }).c; } catch { return null; } };
  return { lastDataAt: one("SELECT MAX(ts) c FROM latest"), activeAlarms: one("SELECT COUNT(*) c FROM alarm_events WHERE cleared_at IS NULL") ?? 0 };
}

/** How this copy of CORE was started. FP_RUNS_AS wins (the Windows Service work sets it); otherwise systemd is recognised by INVOCATION_ID, everything else is a console run. */
export function runsAs(env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform): RunsAs {
  const f = (env.FP_RUNS_AS ?? "").toLowerCase(); if (f === "service" || f === "console" || f === "systemd") return f;
  return platform === "linux" && env.INVOCATION_ID ? "systemd" : "console";
}
