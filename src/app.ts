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
import type { Ingest, LiveTopic } from "./ingest.js";
import type { Registry } from "./gateway/registry.js";
import type { GatewayService } from "./gateway/service.js";
import { registerGatewayRoutes } from "./gateway/routes.js";

const COOKIE = "core_session";
declare module "fastify" { interface FastifyRequest { user?: AuthUser } }

export async function buildApp(db: Db, ingest: Ingest, commands: Commands, reg: Registry | null, gw: GatewayService | null, gwError: string | null = null) {
  const app = Fastify({ logger: { level: "info" }, trustProxy: config.trustProxy, bodyLimit: 64 * 1024 });
  await app.register(cookie);
  await app.register(websocket);
  const clients = new Set<WebSocket>();
  const send = (o: unknown) => { const s = JSON.stringify(o); for (const c of clients) if (c.readyState === 1) c.send(s); };
  const secureFor = (proto: string) => config.cookieSecure === "true" ? true : config.cookieSecure === "false" ? false : proto === "https";

  app.addHook("preHandler", async (req, reply) => {
    if (!req.url.startsWith("/api/") || req.url.startsWith("/api/login") || req.url.startsWith("/api/health")) return;
    const u = userFromToken(db, req.cookies[COOKIE]);
    if (!u) return reply.code(401).send({ error: "login required" });
    req.user = u;
  });
  const admin = async (req: any, reply: any) => { if (req.user?.role !== "admin") return reply.code(403).send({ error: "admin only" }); };

  app.get("/api/health", async () => ({ ok: true, uptime_s: Math.round(process.uptime()), rss_mb: Math.round(process.memoryUsage().rss / 1048576),
    db_mb: Math.round((statSync(config.dbPath).size) / 1048576 * 10) / 10 }));

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
    if (active !== undefined) { if (id === req.user!.id && !active) return reply.code(400).send({ error: "cannot disable yourself" }); db.prepare("UPDATE users SET active=? WHERE id=?").run(active ? 1 : 0, id); if (!active) db.prepare("DELETE FROM sessions WHERE user_id=?").run(id); }
    audit(db, req.user!.username, req.user!.role, "user.update", { id, password: password !== undefined, active });
    return { ok: true };
  });
  app.put<{ Body: { commandTimeoutSec?: number } }>("/api/settings", { preHandler: admin }, async (req, reply) => {
    const v = Number(req.body?.commandTimeoutSec);
    if (!Number.isInteger(v) || v < 3 || v > 120) return reply.code(400).send({ error: "timeout 3-120 s" });
    setSetting(db, "command_timeout_sec", String(v)); audit(db, req.user!.username, req.user!.role, "settings.update", { command_timeout_sec: v });
    return { ok: true };
  });

  if (reg && gw) { registerGatewayRoutes(app, db, reg, gw, admin, () => send({ type: "scada" })); gw.on("update", () => send({ type: "scada" })); }
  else app.get("/api/gateway/status", async () => ({ enabled: false, online: false, lastOk: null, error: gwError }));

  app.get("/ws", { websocket: true }, (socket, req) => {
    if (!userFromToken(db, req.cookies[COOKIE])) { socket.close(4401, "login required"); return; }
    clients.add(socket); socket.on("close", () => clients.delete(socket)); socket.on("error", () => clients.delete(socket));
  });

  const webDir = process.env.WEB_DIR || join(dirname(fileURLToPath(import.meta.url)), "..", "web", "dist");
  if (existsSync(webDir)) {
    await app.register(fstatic, { root: webDir });
    app.setNotFoundHandler((req, reply) => req.url.startsWith("/api/") ? reply.code(404).send({ error: "not found" }) : reply.sendFile("index.html"));
  }
  return { app, pushTelemetry: (t: LiveTopic) => send({ type: "telemetry", ...t }), pushCommand: (c: CommandRow) => send({ type: "command", command: c }) };
}
