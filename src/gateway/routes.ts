// REST API for the C1 gateway. Every route needs login (global hook in app.ts); everything that changes or reveals setup is Admin only.
// Operators get /api/scada and /api/alarms only: no serial-to-slot details, no raw values, no register addresses.
import type { FastifyInstance } from "fastify";
import type { Db } from "../db.js";
import { audit, getSetting } from "../db.js";
import { config } from "../config.js";
import { AlarmTracker } from "./alarms.js";
import { buildView, type AdminSensorView } from "./health.js";
import { HttpError, type Registry } from "./registry.js";
import type { GatewayService } from "./service.js";
import { ProfileService } from "./profile.js";
import type { PortManager } from "../ports/manager.js";

const TEMPLATES = [
  { key: "greenhouse", label: "Greenhouse", name: "Greenhouse", type: "climate", roles: ["Air temperature", "Air humidity"] },
  { key: "field", label: "Field", name: "Field", type: "soil", roles: ["Air temperature", "Air humidity"] },
  { key: "water", label: "Water storage", name: "Water storage", type: "water_storage", roles: ["Air temperature", "Air humidity"] },
];

export function registerGatewayRoutes(app: FastifyInstance, db: Db, reg: Registry, svc: GatewayService, admin: any, push: () => void, prof: ProfileService = new ProfileService(db, reg.map), ports: PortManager | null = null) {
  const A = (req: any) => ({ username: req.user.username as string, role: req.user.role as string });
  app.setErrorHandler((err: any, _req, reply) => { if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message, ...(err.extra as object) }); reply.send(err); });
  const guard = <T>(f: () => T) => { const r = f(); push(); return r; };
  const typesInfo = () => Object.values(reg.map.types).filter((t) => t.enabled).map((t) => ({ key: t.key, label: t.label, ...reg.usage(t.key), presets: reg.allowedIntervals(t.key), commissioningPresets: t.commissioning_presets, commissioning: reg.settings().commissioning, defaultInterval: t.default_interval, unit: t.config.interval.unit, min: t.config.interval.min, max: t.config.interval.max, models: t.models }));

  app.get("/api/scada", async (req) => buildView(db, reg, svc, (req as any).user.role === "admin"));
  // Alarm history: the tracker opens/closes alarm_events rows whenever the gateway reports, and every 15 s (staleness is time-based). It also expires commissioning mode after 8 h.
  const tracker = new AlarmTracker(db, reg, svc); const tick = () => { try { reg.settings(); tracker.tick(); } catch (e) { app.log.error(e); } };
  const timer = setInterval(tick, 15_000); timer.unref(); app.addHook("onClose", async () => clearInterval(timer)); svc.on("update", tick);
  app.get("/api/alarms", async (req) => buildView(db, reg, svc, false).alarms);
  app.get<{ Querystring: { limit?: string } }>("/api/alarms/history", async (req) => { tracker.tick(); return tracker.history(Number(req.query.limit ?? 50) || 50, (req as any).user.role === "admin"); });
  app.post<{ Params: { id: string } }>("/api/alarms/:id/ack", async (req) => { const r = tracker.ack(A(req), Number(req.params.id)); push(); return { ok: true, acked_by: r.acked_by, acked_at: r.acked_at }; });
  app.get("/api/gateway/status", async () => ({ enabled: svc.enabled, online: svc.online, lastOk: svc.lastOk, model: reg.map.gateway_model }));

  // ---- gateway ----
  app.get("/api/gateway", { preHandler: admin }, async () => {
    const pend = (db.prepare("SELECT COUNT(*) c FROM sensors WHERE replaced_by IS NULL AND (sent_slot IS NULL OR sent_slot IS NOT slot OR sent_interval IS NOT reporting_interval)").get() as { c: number }).c
      + (db.prepare("SELECT COUNT(*) c FROM pending_removals").get() as { c: number }).c;
    // The link settings now live in the RS-485 Ports page (database). This is the read-only summary; without a manager (tests) the old environment values are shown.
    const link = ports ? ports.gatewayLink() : config.gwTransport === "off" ? null : { transport: config.gwTransport, host: config.gwHost, port: config.gwPort, serialPath: config.gwSerialPath, baud: config.gwBaud, parity: config.gwParity, dataBits: 8, stopBits: 1,
      address: config.gwAddress || reg.map.default_gateway_address, timeoutMs: config.gwTimeoutMs, retries: config.gwRetries };
    return { enabled: svc.enabled, online: svc.online, lastOk: svc.lastOk, lastError: svc.lastError, link, model: reg.map.gateway_model, manual: reg.map.manual_version, mapVersion: reg.map.map_version, info: svc.info,
      types: typesInfo(), unsent: pend, pending: db.prepare("SELECT type,serial,slot FROM pending_removals").all(), lastSync: svc.lastSync(), unassigned: svc.unassigned(), syncing: svc.syncing, settings: reg.settings() };
  });
  app.put("/api/gateway/settings", { preHandler: admin }, async (req) => guard(() => { reg.saveSettings(A(req), req.body); return { ok: true }; }));
  app.post<{ Body: { type: string } }>("/api/gateway/sync/plan", { preHandler: admin }, async (req) => svc.preview(String(req.body?.type ?? "th")));
  app.post<{ Body: { types?: string[]; confirm?: boolean } }>("/api/gateway/sync", { preHandler: admin }, async (req) => { const r = await svc.sync(A(req), req.body?.types?.length ? req.body.types : ["th"], !!req.body?.confirm); push(); return r; });
  app.post<{ Body: { confirmText?: string } }>("/api/gateway/delete-all", { preHandler: admin }, async (req) => {
    // Strong confirmation: the Admin must type the farm name exactly (as shown in the dialog). Wrong text = nothing happens, and the refusal is audited too.
    if (req.body?.confirmText !== prof.farmName()) { audit(db, A(req).username, A(req).role, "gateway.delete_all.refused", { reason: "confirmation text did not match" }); throw new HttpError(400, `type the farm name "${prof.farmName()}" to confirm`); }
    await svc.deleteAll(A(req)); push(); return { ok: true };
  });
  app.post<{ Body: { address?: number; confirmText?: string } }>("/api/gateway/set-address", { preHandler: admin }, async (req) => {
    const n = Number(req.body?.address), bad = !Number.isInteger(n) || n < 1 || n > 254 || n === 123 || n === 160;
    if (bad || req.body?.confirmText !== prof.farmName()) { audit(db, A(req).username, A(req).role, "gateway.set_address.refused", { address: req.body?.address ?? null, reason: bad ? "address not allowed" : "confirmation text did not match" }); throw new HttpError(400, bad ? "address must be 1 to 254 and never 123 or 160" : `type the farm name "${prof.farmName()}" to confirm`); }
    await svc.setAddress(A(req), n); ports?.syncGatewayAddress(n); push(); return { ok: true, address: n };
  });
  app.post<{ Body: { serial: string } }>("/api/gateway/unassigned/ignore", { preHandler: admin }, async (req) => { svc.ignore(A(req), String(req.body?.serial ?? "")); push(); return { ok: true }; });
  app.post<{ Body: { serial: string } }>("/api/gateway/unassigned/add", { preHandler: admin }, async (req) => guard(() => {
    const u = svc.unassigned().find((x) => x.serial === String(req.body?.serial ?? "").toUpperCase()); if (!u) throw new HttpError(404, "not in the unassigned list");
    reg.add(A(req), u.type, [u.serial], svc.gatewaySlots(u.type).filter((s) => s !== u.slot));
    db.prepare("UPDATE sensors SET slot=?, reporting_interval=? WHERE serial=?").run(u.slot, u.interval, u.serial);   // adopt what the gateway already holds
    svc.reconcile(u.type); return { ok: true };
  }));

  // ---- sensors ----
  app.get("/api/sensors", { preHandler: admin }, async () => ({ types: typesInfo(), sensors: (buildView(db, reg, svc, true).sensors as AdminSensorView[]), zones: reg.zones(), pattern: reg.map.serial_pattern.source }));
  app.post<{ Body: { type: string; serials: string[] | string; labels?: Record<string, string> } }>("/api/sensors", { preHandler: admin }, async (req) => guard(() => {
    const raw = Array.isArray(req.body?.serials) ? req.body.serials : String(req.body?.serials ?? "").split(/[\s,;]+/); const list = raw.map((s) => String(s).trim()).filter(Boolean);
    if (!list.length) throw new HttpError(400, "no serials given"); const type = String(req.body?.type ?? "th");
    return { added: reg.add(A(req), type, list, svc.gatewaySlots(type), req.body?.labels ?? {}) };
  }));
  app.get<{ Params: { serial: string } }>("/api/sensors/:serial", { preHandler: admin }, async (req) => {
    const serial = req.params.serial.toUpperCase(); const s = reg.get(serial); if (!s) throw new HttpError(404, "sensor not found");
    const v = (buildView(db, reg, svc, true).sensors as AdminSensorView[]).find((x) => x.serial === serial);
    return { sensor: v ?? null, row: { serial: s.serial, type: s.type, label: s.label, replacedBy: s.replaced_by, slot: s.slot }, calibrations: reg.calHistory(serial), active: Object.fromEntries(["temperature", "humidity"].map((m) => [m, reg.calRow(serial, m) ?? null])),
      limits: reg.limits(), type: { ...typesInfo().find((t) => t.key === s.type) } };
  });
  app.patch<{ Params: { serial: string }; Body: any }>("/api/sensors/:serial", { preHandler: admin }, async (req) => guard(() => { reg.update(A(req), req.params.serial.toUpperCase(), req.body ?? {}); return { ok: true }; }));
  app.delete<{ Params: { serial: string } }>("/api/sensors/:serial", { preHandler: admin }, async (req) => guard(() => { reg.remove(A(req), req.params.serial.toUpperCase()); return { ok: true }; }));
  app.post<{ Params: { serial: string }; Body: { newSerial: string } }>("/api/sensors/:serial/replace", { preHandler: admin }, async (req) => guard(() => ({ newSerial: reg.replace(A(req), req.params.serial.toUpperCase(), String(req.body?.newSerial ?? "")) })));
  app.get<{ Params: { serial: string }; Querystring: { metric?: string; range?: string } }>("/api/sensors/:serial/trend", { preHandler: admin }, async (req) => {
    const serial = req.params.serial.toUpperCase(), s = reg.get(serial); if (!s) throw new HttpError(404, "sensor not found"); const metric = req.query.metric === "humidity" ? "humidity" : "temperature";
    const span = { "24h": 86400e3, "7d": 7 * 86400e3, "30d": 30 * 86400e3 }[req.query.range ?? "24h"] ?? 86400e3; const from = Date.now() - span;
    const q = (m: string) => db.prepare("SELECT h.ts ts,h.value v FROM history_raw h JOIN series x ON x.id=h.series_id WHERE x.topic=? AND x.sensor_key=? AND x.metric=? AND h.ts>=? ORDER BY h.ts").all(`gateway/${s.type}`, serial, m, from) as { ts: number; v: number }[];
    const cal = q(metric), raw = new Map(q(metric + "_raw").map((r) => [r.ts, r.v])); const step = Math.max(1, Math.ceil(cal.length / 400));
    return { points: cal.filter((_, i) => i % step === 0).map((r) => ({ ts: r.ts, cal: r.v, raw: raw.get(r.ts) ?? null })), markers: reg.calHistory(serial).filter((c) => c.metric === metric && c.calibrated_at >= from).map((c) => ({ ts: c.calibrated_at, method: c.method })) };
  });
  app.post<{ Params: { serial: string }; Body: any }>("/api/sensors/:serial/calibrate", { preHandler: admin }, async (req) => guard(() => ({ cal: reg.calibrate(A(req), req.params.serial.toUpperCase(), (req.body ?? {}) as any) })));
  app.post<{ Params: { serial: string }; Body: { metric: string } }>("/api/sensors/:serial/calibrate/reset", { preHandler: admin }, async (req) => guard(() => { reg.resetCal(A(req), req.params.serial.toUpperCase(), String(req.body?.metric)); return { ok: true }; }));
  app.post<{ Params: { serial: string }; Body: { metric: string; dueAt: number | null } }>("/api/sensors/:serial/calibrate/due", { preHandler: admin }, async (req) => guard(() => { reg.setCalDue(A(req), req.params.serial.toUpperCase(), String(req.body?.metric), req.body?.dueAt ?? null); return { ok: true }; }));

  // ---- farm structure ----
  app.get("/api/structure", { preHandler: admin }, async () => ({ zones: reg.zones(), points: reg.points(), sensors: (buildView(db, reg, svc, true).sensors as AdminSensorView[]).map((s) => ({ serial: s.serial, label: s.labelSet ? s.label : "", slot: s.slot, zoneId: s.zoneId, type: s.type })), templates: TEMPLATES }));
  app.post<{ Body: { name: string; type: string } }>("/api/zones", { preHandler: admin }, async (req) => guard(() => ({ id: reg.addZone(A(req), req.body?.name, req.body?.type) })));
  app.patch<{ Params: { id: string }; Body: any }>("/api/zones/:id", { preHandler: admin }, async (req) => guard(() => { reg.updateZone(A(req), Number(req.params.id), req.body ?? {}); return { ok: true }; }));
  app.delete<{ Params: { id: string } }>("/api/zones/:id", { preHandler: admin }, async (req) => guard(() => { reg.removeZone(A(req), Number(req.params.id)); return { ok: true }; }));
  app.post<{ Body: { serial: string; zoneId: number | null } }>("/api/zones/assign", { preHandler: admin }, async (req) => guard(() => { reg.assignZone(A(req), String(req.body?.serial).toUpperCase(), req.body?.zoneId ?? null); return { ok: true }; }));
  app.delete<{ Params: { id: string } }>("/api/points/:id", { preHandler: admin }, async (req) => guard(() => { reg.removePoint(A(req), Number(req.params.id)); return { ok: true }; }));
  app.patch<{ Params: { id: string }; Body: { role: string } }>("/api/points/:id", { preHandler: admin }, async (req) => guard(() => { reg.setPointRole(A(req), Number(req.params.id), req.body?.role); return { ok: true }; }));

  // ---- backup ----
  app.get("/api/backup", { preHandler: admin }, async (req, reply) => { audit(db, (req as any).user.username, "admin", "backup.export", {}); reply.header("content-disposition", 'attachment; filename="farmpilot-core-backup.json"'); return { ...reg.exportAll(), ...prof.exportParts(), ...(ports ? ports.exportParts() : {}) }; });
  app.get("/api/backup/status", { preHandler: admin }, async () => { const r = db.prepare("SELECT MAX(ts) t FROM audit_log WHERE action='backup.export'").get() as { t: number | null }; return { lastExportAt: r?.t ?? null, warnDays: Number(getSetting(db, "backup.warn_days", "7")) }; });
  app.post("/api/backup/restore", { preHandler: admin, bodyLimit: 2 * 1024 * 1024 }, async (req) => { const b = req.body as any; let warnings: string[] = []; if (b && typeof b === "object") { prof.checkBackup(b); warnings = ports?.checkBackup(b) ?? []; } reg.restore(A(req), req.body); prof.restoreParts(A(req), b); await ports?.restoreParts(A(req), b, warnings); push(); return warnings.length ? { ok: true, warnings } : { ok: true }; });
}
