import Fastify from "fastify";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import fstatic from "@fastify/static";
import { existsSync } from "node:fs";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { WebSocket } from "ws";
import { config } from "./config.js";
import { audit, getSetting, setSetting, type Db } from "./db.js";
import { clearFails, createSession, destroySession, hashPassword, noteFail, throttled, userFromToken, verifyPassword, type AuthUser } from "./auth.js";
import type { Commands, CommandRow } from "./commands.js";
import { PUMPS } from "./commands.js";
import { controlView } from "./control.js";
import type { Ingest, LiveTopic } from "./ingest.js";
import type { Registry } from "./gateway/registry.js";
import type { GatewayService } from "./gateway/service.js";
import { registerGatewayRoutes } from "./gateway/routes.js";
import { registerProfileRoutes } from "./gateway/profile-routes.js";
import { ProfileService } from "./gateway/profile.js";
import { HttpError } from "./gateway/registry.js";
import type { PortManager } from "./ports/manager.js";
import { registerPortRoutes } from "./ports/routes.js";
import { registerAboutRoutes } from "./about/routes.js";
import { LicenceService } from "./licence/service.js";
import { registerLicenceRoutes } from "./licence/routes.js";
import { registerSupportRoutes } from "./about/support.js";
import { readBuild } from "./about/build.js";
import { registerHistoryRoutes } from "./history/routes.js";
import { MqttSourceService } from "./mqtt/service.js";
import { registerMqttRoutes } from "./mqtt/routes.js";

const COOKIE = "core_session";
declare module "fastify" { interface FastifyRequest { user?: AuthUser } }

export async function buildApp(db: Db, ingest: Ingest, commands: Commands, reg: Registry | null, gw: GatewayService | null, gwError: string | null = null, ports: PortManager | null = null, lic: LicenceService | null = null, mqttSrc: MqttSourceService | null = null) {
  const app = Fastify({ logger: { level: "info" }, trustProxy: config.trustProxy, bodyLimit: 64 * 1024 });
  // Every registered route is recorded, so tests can call ALL of them as an Operator (test/operator-access.test.ts).
  const routes: { method: string; url: string }[] = []; app.addHook("onRoute", (r) => { for (const m of [r.method].flat()) routes.push({ method: String(m), url: r.url }); });
  await app.register(cookie);
  await app.register(websocket);
  const clients = new Set<WebSocket>();
  const send = (o: unknown) => { const s = JSON.stringify(o); for (const c of clients) if (c.readyState === 1) c.send(s); };
  const secureFor = (proto: string) => config.cookieSecure === "true" ? true : config.cookieSecure === "false" ? false : proto === "https";

  app.addHook("preHandler", async (req, reply) => {
    if (!req.url.startsWith("/api/") || req.url.startsWith("/api/login") || req.url.startsWith("/api/health") || req.url.startsWith("/api/branding")) return;
    const u = userFromToken(db, req.cookies[COOKIE]);
    if (!u) return reply.code(401).send({ error: "login required" });
    req.user = u;
  });
  /** True when user `id` is an active Admin and no other active Admin exists: deleting or disabling them would lock everyone out of Settings. */
  const lastActiveAdmin = (id: number) => { const u = db.prepare("SELECT role,active FROM users WHERE id=?").get(id) as { role: string; active: number } | undefined; if (!u || u.role !== "admin" || !u.active) return false; return (db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin' AND active=1 AND id<>?").get(id) as { c: number }).c === 0; };
  const admin = async (req: any, reply: any) => { if (req.user?.role !== "admin") return reply.code(403).send({ error: "admin only" }); };

  // version, build and build_label come from about/build.ts: the login footer and the About page print the same label.
  app.get("/api/health", async () => ({ ok: true, version: readBuild().version, build: readBuild().build, build_label: readBuild().label, uptime_s: Math.round(process.uptime()), rss_mb: Math.round(process.memoryUsage().rss / 1048576),
    db_mb: (() => { try { return Math.round((statSync(config.dbPath).size) / 1048576 * 10) / 10; } catch { return null; } })() }));      // 2026-11-17: no database FILE (in-memory test databases) is not a reason for /api/health to fail

  app.post<{ Body: { username?: string; password?: string } }>("/api/login", async (req, reply) => {
    const username = String(req.body?.username ?? "").slice(0, 64), password = String(req.body?.password ?? "").slice(0, 200);
    const key = `${username.toLowerCase()}|${req.ip}`;
    const until = Math.max(throttled(db, "ui", key), throttled(db, "ip", req.ip));
    if (until) return reply.code(429).header("retry-after", String(Math.ceil((until - Date.now()) / 1000))).send({ error: "too many attempts, wait a few minutes" });
    const row = db.prepare("SELECT * FROM users WHERE username=? AND active=1").get(username) as any;
    if (!row || !verifyPassword(password, row.pass_hash)) { noteFail(db, "ui", key); noteFail(db, "ip", req.ip); audit(db, username || "?", "unknown", "login.fail", { ip: req.ip }); return reply.code(401).send({ error: "wrong user or password" }); }
    clearFails(db, "ui", key);
    const token = createSession(db, row.id);
    audit(db, row.username, row.role, "login", { ip: req.ip });
    reply.setCookie(COOKIE, token, { httpOnly: true, sameSite: "strict", path: "/", maxAge: config.sessionHours * 3600, secure: secureFor(req.protocol) });
    return { username: row.username, role: row.role };
  });
  app.post("/api/logout", async (req, reply) => { const t = req.cookies[COOKIE]; if (t) destroySession(db, t); reply.clearCookie(COOKIE, { path: "/" }); return { ok: true }; });
  app.get("/api/me", async (req) => req.user);

  app.get("/api/state", async () => ({ farm: config.farm, now: Date.now(), topics: ingest.snapshot(), commands: commands.recent(10), commandTimeoutSec: Number(getSetting(db, "command_timeout_sec", String(config.commandTimeoutSec))) }));

  // CONTROL device list (Operator and Admin). The live state comes from /api/state + the WebSocket; the web app derives it once for CONTROL and the SCADA status line.
  app.get("/api/control", async () => controlView());

  app.post<{ Body: { pump?: string; action?: string } }>("/api/commands", async (req, reply) => {
    const { pump, action } = req.body ?? {};
    if (!pump || !PUMPS.includes(pump) || (action !== "on" && action !== "off")) return reply.code(400).send({ error: "pump must be one of " + PUMPS.join(",") + ", action on|off" });
    return commands.create(req.user!, pump, action);
  });

  // Admin-only, minimal
  app.get("/api/users", { preHandler: admin }, async () => db.prepare("SELECT id,username,role,active,created_at FROM users ORDER BY id").all());
  app.post<{ Body: { username?: string; password?: string; role?: string } }>("/api/users", { preHandler: admin }, async (req, reply) => {
    const { username, password, role } = req.body ?? {};
    if (!username || !/^[A-Za-z0-9_.-]{2,32}$/.test(username) || !password || password.length < 8 || (role !== "operator" && role !== "admin")) return reply.code(400).send({ error: "username 2-32 chars, password 8+ chars, role operator|admin" });
    try { db.prepare("INSERT INTO users(username,pass_hash,role,created_at) VALUES(?,?,?,?)").run(username, hashPassword(password), role, Date.now()); }
    catch { return reply.code(409).send({ error: "user exists" }); }
    audit(db, req.user!.username, req.user!.role, "user.create", { username, role });
    return { ok: true };
  });
  app.post<{ Params: { id: string }; Body: { password?: string; active?: boolean } }>("/api/users/:id", { preHandler: admin }, async (req, reply) => {
    const id = Number(req.params.id); const { password, active } = req.body ?? {};
    if (password !== undefined) { if (password.length < 8) return reply.code(400).send({ error: "password 8+ chars" }); db.prepare("UPDATE users SET pass_hash=? WHERE id=?").run(hashPassword(password), id); db.prepare("DELETE FROM sessions WHERE user_id=?").run(id); }
    if (active !== undefined) { if (id === req.user!.id && !active) return reply.code(400).send({ error: "cannot disable yourself" }); if (!active && lastActiveAdmin(id)) return reply.code(400).send({ error: "cannot disable the last active Admin" }); db.prepare("UPDATE users SET active=? WHERE id=?").run(active ? 1 : 0, id); if (!active) db.prepare("DELETE FROM sessions WHERE user_id=?").run(id); }
    audit(db, req.user!.username, req.user!.role, "user.update", { id, password: password !== undefined, active });
    return { ok: true };
  });
  app.delete<{ Params: { id: string } }>("/api/users/:id", { preHandler: admin }, async (req, reply) => {
    const id = Number(req.params.id); const u = db.prepare("SELECT username FROM users WHERE id=?").get(id) as { username: string } | undefined;
    if (!u) return reply.code(404).send({ error: "user not found" }); if (id === req.user!.id) return reply.code(400).send({ error: "cannot delete yourself" });
    if (lastActiveAdmin(id)) return reply.code(400).send({ error: "cannot delete the last active Admin" });
    db.transaction(() => { db.prepare("DELETE FROM sessions WHERE user_id=?").run(id); db.prepare("DELETE FROM users WHERE id=?").run(id); audit(db, req.user!.username, req.user!.role, "user.delete", { id, username: u.username }); })();
    return { ok: true };      // audit_log keeps every row the user ever wrote (append-only), by username
  });
  app.put<{ Body: { commandTimeoutSec?: number } }>("/api/settings", { preHandler: admin }, async (req, reply) => {
    const v = Number(req.body?.commandTimeoutSec);
    if (!Number.isInteger(v) || v < 3 || v > 120) return reply.code(400).send({ error: "timeout 3-120 s" });
    setSetting(db, "command_timeout_sec", String(v)); audit(db, req.user!.username, req.user!.role, "settings.update", { command_timeout_sec: v });
    return { ok: true };
  });

  app.setErrorHandler((err: any, _req, reply) => { if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message, ...(err.extra as object) }); reply.send(err); });
  const prof = new ProfileService(db, reg?.map ?? null);
  // Public (the login page needs it): ONLY the farm name, cached for a minute, at most 30 calls per minute and address. No logo, no site name, nothing else.
  const brandHits = new Map<string, { n: number; t: number }>();
  app.get("/api/branding", async (req, reply) => {
    const now = Date.now(), h = brandHits.get(req.ip); if (!h || now - h.t > 60_000) brandHits.set(req.ip, { n: 1, t: now }); else if (++h.n > 30) return reply.code(429).header("retry-after", "60").send({ error: "slow down" });
    if (brandHits.size > 1000) for (const [k, v] of brandHits) if (now - v.t > 60_000) brandHits.delete(k);
    reply.header("cache-control", "public, max-age=60"); return { farm_name: prof.farmName() };
  });
  registerProfileRoutes(app, prof, admin, () => send({ type: "scada" }));
  // Licence: FREE until a licence file is installed. It only limits ADDING sensors and gateways (see licence/service.ts); nothing here can stop polling, alarms or commands.
  const licence = lic ?? new LicenceService(db); if (reg) reg.limiter = licence; if (ports) ports.limiter = licence;
  registerAboutRoutes(app, { db, admin, prof, licence: () => licence.summary() }); registerLicenceRoutes(app, licence, admin, () => send({ type: "scada" }));
  registerSupportRoutes(app, { db, admin, prof, licence: () => licence.summary(), ports, gw });
  if (reg && gw) { registerGatewayRoutes(app, db, reg, gw, admin, () => send({ type: "scada" }), prof, ports); gw.on("update", () => send({ type: "scada" })); registerHistoryRoutes(app, { db, reg, svc: gw, prof, licence }); }
  else app.get("/api/gateway/status", async () => ({ enabled: false, online: false, lastOk: null, error: gwError }));
  if (ports) registerPortRoutes(app, ports, admin, () => send({ type: "ports" }));
  // MQTT Payload source (2026-11-18). index.ts starts it; without one passed in (tests) an idle service is created so the routes still work. It never counts against the licence for now (TODO in mqtt/service.ts).
  registerMqttRoutes(app, mqttSrc ?? new MqttSourceService(db, ingest), admin);

  app.get("/ws", { websocket: true }, (socket, req) => {
    if (!userFromToken(db, req.cookies[COOKIE])) { socket.close(4401, "login required"); return; }
    clients.add(socket); socket.on("close", () => clients.delete(socket)); socket.on("error", () => clients.delete(socket));
  });

  const webDir = process.env.WEB_DIR || join(dirname(fileURLToPath(import.meta.url)), "..", "web", "dist");
  if (existsSync(webDir)) {
    await app.register(fstatic, { root: webDir });
    app.setNotFoundHandler((req, reply) => req.url.startsWith("/api/") ? reply.code(404).send({ error: "not found" }) : reply.sendFile("index.html"));
  }
  return { app, routes, pushTelemetry: (t: LiveTopic) => send({ type: "telemetry", ...t }), pushCommand: (c: CommandRow) => send({ type: "command", command: c }) };
}
