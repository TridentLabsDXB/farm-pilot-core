// 2026-11-19 -- Connected Boxes API (Online build only: app.ts registers this file only when FP_ONLINE=1; a standalone build answers 404).
// Two PUBLIC routes for the boxes (their own key check, HTTPS only, 4 KB body limit) and ADMIN-ONLY routes for the page.
// There is deliberately no route that sends anything to a box.
import type { FastifyInstance } from "fastify";
import { audit, type Db } from "../db.js";
import { EXPIRING_DAYS } from "../deployments/calc.js";
import { DEVICE_ID_RE } from "../licence/device.js";
import { FleetService, bad, type BoxRow, type StoredReport } from "./service.js";
import { DAY, boxStatus } from "./status.js";

export const FLEET_PUBLIC = new Set(["/api/fleet/enrol", "/api/fleet/report"]);
const BODY_LIMIT = 4096;

export function registerFleetRoutes(app: FastifyInstance, db: Db, admin: (req: any, reply: any) => Promise<unknown>, nowFn: () => number = Date.now, tickMs = 60_000): FleetService {
  const svc = new FleetService(db, nowFn), A = { preHandler: admin };
  const who = (req: any) => req.user.username as string;
  const fail = (reply: any, e: any) => { const st = e?.status; if (st) { if (e.retryAfter) reply.header("retry-after", String(e.retryAfter)); return reply.code(st).send({ error: e.message, ...(e.extra ?? {}) }); } throw e; };
  const secure = (req: any, reply: any) => { if (req.protocol !== "https") { reply.code(400).send({ error: "HTTPS is required" }); return false; } return true; };     // behind the proxy: X-Forwarded-Proto (trustProxy)

  // ---- box-facing ----
  app.post<{ Body: any }>("/api/fleet/enrol", { bodyLimit: BODY_LIMIT }, async (req, reply) => {
    if (!secure(req, reply)) return;
    try { const hdr = String(req.headers["x-device-id"] ?? "").toUpperCase(); if (hdr && hdr !== String((req.body as any)?.device_id ?? "").toUpperCase()) throw bad(400, "Device ID header and body differ"); const r = svc.enrol(req.ip, req.body ?? {}); return reply.code(r.http).header("cache-control", "no-store").send(r.body); }
    catch (e) { return fail(reply, e); }
  });
  app.post<{ Body: any }>("/api/fleet/report", { bodyLimit: BODY_LIMIT }, async (req, reply) => {
    if (!secure(req, reply)) return;
    try {
      const id = String(req.headers["x-device-id"] ?? "").trim().toUpperCase(), auth = String(req.headers.authorization ?? ""), m = /^Bearer ([A-Za-z0-9_-]{16,200})$/.exec(auth);
      if (!DEVICE_ID_RE.test(id)) throw bad(400, "X-Device-Id must look like FP-XXXX-XXXX-XXXX");
      const r = svc.report(req.ip, id, m?.[1] ?? null, req.body); return reply.header("cache-control", "no-store").send({ ok: true, ...r });
    } catch (e) { return fail(reply, e); }
  });

  // ---- admin ----
  const licKnown = (): Set<string> => { try { return new Set((db.prepare("SELECT device_id FROM licence_deployments").all() as { device_id: string }[]).map((r) => r.device_id)); } catch { return new Set(); } };
  const dayNum = (ms: number) => Math.floor(ms / DAY);
  const view = (b: BoxRow, t: number, known: Set<string>, pct: Map<string, number | null>) => {
    const r: StoredReport | null = b.last_report ? JSON.parse(b.last_report) : null;
    const status = b.state === "revoked" ? "REVOKED" : b.state === "approved" ? boxStatus(b.last_report_at, b.interval_s, t) : "NOT_ENROLLED";
    const until = r?.licence.valid_until ? Date.parse(r.licence.valid_until) : null, days = until === null ? null : dayNum(until) - dayNum(t);
    return { id: b.id, device_id: b.device_id, name: b.display_name || r?.box_name || b.reported_name || b.device_id, renamed: !!b.display_name, state: b.state, status, interval_s: b.interval_s,
      licence: r ? { type: r.licence.type, state: r.licence.state, valid_until: r.licence.valid_until, days_left: days, expiring: days !== null && days <= EXPIRING_DAYS } : null,
      sources: r?.usage.data_sources ?? null, sensors: r?.usage.sensors ?? null, version: r?.version ?? b.version, build: r?.build ?? null, os: r?.os ?? null, runs_as: r?.runs_as ?? null, uptime_s: r?.uptime_s ?? null,
      last_data_at: r?.last_data_at ?? null, active_alarms: r?.active_alarms ?? null, last_report_at: b.last_report_at, last_seen_s: b.last_report_at === null ? null : Math.max(0, Math.round((t - b.last_report_at) / 1000)),
      first_enrolled_at: b.first_enrolled_at, auth_failures: b.auth_failures, licence_known: known.has(b.device_id), percent_online_30d: pct.get(b.device_id) ?? null };
  };
  const all = () => { const t = nowFn(), known = licKnown(), pct = svc.percent30(); return (db.prepare("SELECT * FROM fleet_boxes WHERE state IN ('approved','revoked') ORDER BY COALESCE(display_name, reported_name) COLLATE NOCASE").all() as BoxRow[]).map((b) => view(b, t, known, pct)); };
  app.get("/api/fleet/boxes", A, async () => {
    const t = nowFn(), boxes = all(), waiting = (db.prepare("SELECT id,device_id,reported_name,version,requested_at FROM fleet_boxes WHERE state='pending' ORDER BY requested_at").all() as any[]).map((w) => ({ id: w.id, device_id: w.device_id, name: w.reported_name, version: w.version, requested_at: w.requested_at, asked_s: Math.round((t - w.requested_at) / 1000), licence_known: licKnown().has(w.device_id) }));
    const live = boxes.filter((b) => b.state === "approved"), n = (s: string) => live.filter((b) => b.status === s).length;
    return { now: t, boxes, waiting, codes: svc.openCodes(), kpi: { boxes: live.length, online: n("ONLINE"), late: n("LATE"), offline: n("OFFLINE"), waiting: waiting.length } };
  });
  app.get<{ Params: { id: string } }>("/api/fleet/boxes/:id", A, async (req, reply) => { const b = svc.boxById(req.params.id); if (!b || !["approved", "revoked"].includes(b.state)) return reply.code(404).send({ error: "not found" }); return { box: view(b, nowFn(), licKnown(), svc.percent30()) }; });
  app.get<{ Params: { id: string } }>("/api/fleet/boxes/:id/history", A, async (req, reply) => { const b = svc.boxById(req.params.id); if (!b) return reply.code(404).send({ error: "not found" }); return svc.history(b.device_id); });
  for (const act of ["approve", "reject", "revoke"] as const) app.post<{ Params: { id: string } }>(`/api/fleet/boxes/:id/${act}`, A, async (req, reply) => { try { svc[act](who(req), req.params.id); return { ok: true }; } catch (e) { return fail(reply, e); } });
  app.patch<{ Params: { id: string }; Body: { name?: string } }>("/api/fleet/boxes/:id", A, async (req, reply) => { try { svc.rename(who(req), req.params.id, req.body?.name); return { ok: true }; } catch (e) { return fail(reply, e); } });
  app.post<{ Body: { note?: string } }>("/api/fleet/codes", A, async (req) => svc.createCode(who(req), req.body?.note));

  // CSV of the list. Box names come from the boxes, so a cell that starts with = + - @ is defused (spreadsheet formula injection).
  app.get("/api/fleet/export.csv", A, async (req, reply) => {
    const cell = (v: unknown) => { let s = v === null || v === undefined ? "" : String(v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const head = ["status", "name", "device_id", "licence", "licence_valid_until", "data_sources", "data_sources_max", "sensors", "sensors_max", "version", "last_seen_utc", "first_enrolled_utc", "percent_online_30d"];
    const rows = all().map((b) => [b.status, b.name, b.device_id, b.licence?.type, b.licence?.valid_until?.slice(0, 10), b.sources?.n, b.sources ? (b.sources.max ?? "unlimited") : "", b.sensors?.n, b.sensors ? (b.sensors.max ?? "unlimited") : "", b.version, b.last_report_at ? new Date(b.last_report_at).toISOString() : "", b.first_enrolled_at ? new Date(b.first_enrolled_at).toISOString() : "", b.percent_online_30d]);
    audit(db, who(req), "admin", "fleet.export_csv", { rows: rows.length });
    return reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", `attachment; filename="connected-boxes-${new Date(nowFn()).toISOString().slice(0, 10)}.csv"`).send([head, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n");
  });

  // ---- background work: status events once a minute, the 30-day prune once a night. Cleared when the app closes. ----
  const timer = setInterval(() => { try { svc.tick(); svc.maybePrune(); } catch (e) { app.log.error(e); } }, tickMs); timer.unref?.(); app.addHook("onClose", async () => clearInterval(timer));
  return svc;
}
